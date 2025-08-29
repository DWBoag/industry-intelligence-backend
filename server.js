// ========================================
// BACKEND API CODE (Node.js + Express)
// ========================================

// server.js
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());

// ========================================
// STRIPE PAYMENT INTEGRATION
// ========================================

// Create Stripe checkout session
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { priceId, planId } = req.body;
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: {
        planId: planId,
      },
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe webhook handler
app.post('/api/stripe-webhook', express.raw({type: 'application/json'}), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`Webhook signature verification failed.`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      // Save user subscription to database
      handleSuccessfulPayment(session);
      break;
    case 'customer.subscription.deleted':
      const subscription = event.data.object;
      // Handle subscription cancellation
      handleSubscriptionCancellation(subscription);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({received: true});
});

async function handleSuccessfulPayment(session) {
  try {
    const { customer, subscription, metadata } = session;
    
    // Save user and subscription to database
    await pool.query(
      'INSERT INTO users (stripe_customer_id, subscription_id, plan_id, status) VALUES ($1, $2, $3, $4) ON CONFLICT (stripe_customer_id) DO UPDATE SET subscription_id = $2, plan_id = $3, status = $4',
      [customer, subscription, metadata.planId, 'active']
    );
    
    console.log('User subscription saved successfully');
  } catch (error) {
    console.error('Error saving user subscription:', error);
  }
}

async function handleSubscriptionCancellation(subscription) {
  try {
    await pool.query(
      'UPDATE users SET status = $1 WHERE subscription_id = $2',
      ['cancelled', subscription.id]
    );
    
    console.log('Subscription cancellation handled');
  } catch (error) {
    console.error('Error handling subscription cancellation:', error);
  }
}

// ========================================
// INDUSTRY DATA API ENDPOINTS
// ========================================

// Get all companies with filters
app.get('/api/companies', async (req, res) => {
  try {
    const { industry, search, limit = 50, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM companies WHERE 1=1';
    const params = [];
    
    if (industry) {
      query += ' AND industry_code = $' + (params.length + 1);
      params.push(industry);
    }
    
    if (search) {
      query += ' AND (name ILIKE $' + (params.length + 1) + ' OR ticker_symbol ILIKE $' + (params.length + 2) + ')';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    query += ' ORDER BY market_cap DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// Get specific company details
app.get('/api/companies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const companyQuery = 'SELECT * FROM companies WHERE id = $1';
    const metricsQuery = 'SELECT * FROM financial_metrics WHERE company_id = $1 ORDER BY period_date DESC LIMIT 20';
    const marketQuery = 'SELECT * FROM market_data WHERE company_id = $1 ORDER BY measurement_date DESC LIMIT 20';
    
    const [company, metrics, market] = await Promise.all([
      pool.query(companyQuery, [id]),
      pool.query(metricsQuery, [id]),
      pool.query(marketQuery, [id])
    ]);
    
    if (company.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    
    res.json({
      company: company.rows[0],
      financialMetrics: metrics.rows,
      marketData: market.rows
    });
  } catch (error) {
    console.error('Error fetching company details:', error);
    res.status(500).json({ error: 'Failed to fetch company details' });
  }
});

// Get industry analysis
app.get('/api/industries/:code/analysis', async (req, res) => {
  try {
    const { code } = req.params;
    
    const industryQuery = `
      SELECT 
        i.industry_title,
        COUNT(c.id) as company_count,
        AVG(c.market_cap) as avg_market_cap,
        AVG(fm.metric_value) as avg_growth_rate
      FROM industries i
      LEFT JOIN companies c ON i.naics_code = c.naics_code
      LEFT JOIN financial_metrics fm ON c.id = fm.company_id AND fm.metric_type = 'revenue_growth'
      WHERE i.naics_code = $1
      GROUP BY i.industry_title
    `;
    
    const result = await pool.query(industryQuery, [code]);
    res.json(result.rows[0] || {});
  } catch (error) {
    console.error('Error fetching industry analysis:', error);
    res.status(500).json({ error: 'Failed to fetch industry analysis' });
  }
});

// AI-powered company comparison
app.post('/api/compare', async (req, res) => {
  try {
    const { companyIds, metrics = ['revenue', 'market_cap', 'growth_rate'] } = req.body;
    
    if (!companyIds || companyIds.length < 2) {
      return res.status(400).json({ error: 'At least 2 companies required for comparison' });
    }
    
    const placeholders = companyIds.map((_, i) => `$${i + 1}`).join(',');
    
    const query = `
      SELECT 
        c.id,
        c.name,
        c.ticker_symbol,
        c.market_cap,
        AVG(CASE WHEN fm.metric_type = 'revenue' THEN fm.metric_value END) as revenue,
        AVG(CASE WHEN fm.metric_type = 'revenue_growth' THEN fm.metric_value END) as growth_rate,
        AVG(ns.sentiment_score) as avg_sentiment
      FROM companies c
      LEFT JOIN financial_metrics fm ON c.id = fm.company_id
      LEFT JOIN news_sentiment ns ON c.id = ns.company_id AND ns.published_date > NOW() - INTERVAL '30 days'
      WHERE c.id IN (${placeholders})
      GROUP BY c.id, c.name, c.ticker_symbol, c.market_cap
    `;
    
    const result = await pool.query(query, companyIds);
    
    // AI-powered insights (simplified version)
    const insights = generateComparisonInsights(result.rows);
    
    res.json({
      companies: result.rows,
      insights: insights
    });
  } catch (error) {
    console.error('Error comparing companies:', error);
    res.status(500).json({ error: 'Failed to compare companies' });
  }
});

function generateComparisonInsights(companies) {
  // Simplified AI insights logic
  const insights = [];
  
  const sortedByMarketCap = [...companies].sort((a, b) => b.market_cap - a.market_cap);
  const sortedByGrowth = [...companies].sort((a, b) => b.growth_rate - a.growth_rate);
  
  insights.push(`${sortedByMarketCap[0].name} leads in market capitalization with $${(sortedByMarketCap[0].market_cap / 1000000000).toFixed(1)}B`);
  insights.push(`${sortedByGrowth[0].name} shows highest growth rate at ${sortedByGrowth[0].growth_rate?.toFixed(1)}%`);
  
  const avgSentiment = companies.reduce((sum, c) => sum + (c.avg_sentiment || 0), 0) / companies.length;
  insights.push(`Overall market sentiment is ${avgSentiment > 0.6 ? 'positive' : avgSentiment > 0.4 ? 'neutral' : 'negative'}`);
  
  return insights;
}

// Search endpoint for AI agent
app.post('/api/search', async (req, res) => {
  try {
    const { query, filters = {} } = req.body;
    
    // Full-text search across companies and news
    const searchQuery = `
      SELECT 
        c.id,
        c.name,
        c.ticker_symbol,
        c.industry_code,
        c.market_cap,
        ts_rank(to_tsvector('english', c.name || ' ' || c.description), plainto_tsquery('english', $1)) as relevance
      FROM companies c
      WHERE to_tsvector('english', c.name || ' ' || c.description) @@ plainto_tsquery('english', $1)
      ORDER BY relevance DESC, market_cap DESC
      LIMIT 20
    `;
    
    const result = await pool.query(searchQuery, [query]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error in search:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ========================================
// DATA COLLECTION PIPELINE
// ========================================

// Function to collect data from free sources
async function collectFreeData() {
  // This would implement actual data collection from:
  // - SEC EDGAR API
  // - Yahoo Finance API  
  // - Federal Reserve Economic Data (FRED)
  // - Census Bureau API
  // etc.
  
  console.log('Collecting data from free sources...');
  // Implementation would go here
}

// Function to collect data from premium sources (for paid users)
async function collectPremiumData() {
  // This would implement actual data collection from:
  // - Bloomberg API
  // - S&P Capital IQ
  // - Thomson Reuters
  // - IBISWorld
  // etc.
  
  console.log('Collecting data from premium sources...');
  // Implementation would go here
}

// Scheduled data collection
setInterval(collectFreeData, 60 * 60 * 1000); // Every hour
setInterval(collectPremiumData, 60 * 60 * 1000 * 6); // Every 6 hours

// ========================================
// DATABASE SCHEMA SETUP
// ========================================

const createTables = async () => {
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE,
      stripe_customer_id VARCHAR(255) UNIQUE,
      subscription_id VARCHAR(255),
      plan_id VARCHAR(50),
      status VARCHAR(50) DEFAULT 'trial',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createCompaniesTable = `
    CREATE TABLE IF NOT EXISTS companies (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      ticker_symbol VARCHAR(10),
      industry_code VARCHAR(10),
      naics_code VARCHAR(10),
      sic_code VARCHAR(10),
      market_cap DECIMAL(15,2),
      headquarters_country VARCHAR(3),
      founded_date DATE,
      employee_count INTEGER,
      website VARCHAR(255),
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createFinancialMetricsTable = `
    CREATE TABLE IF NOT EXISTS financial_metrics (
      id BIGSERIAL PRIMARY KEY,
      company_id BIGINT REFERENCES companies(id),
      metric_type VARCHAR(50),
      metric_value DECIMAL(15,2),
      metric_unit VARCHAR(20),
      period_type VARCHAR(20),
      period_date DATE,
      data_source VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createIndexes = `
    CREATE INDEX IF NOT EXISTS idx_companies_industry ON companies(industry_code, naics_code);
    CREATE INDEX IF NOT EXISTS idx_companies_market_cap ON companies(market_cap DESC);
    CREATE INDEX IF NOT EXISTS idx_financial_metrics_lookup ON financial_metrics(company_id, metric_type, period_date DESC);
  `;

  try {
    await pool.query(createUsersTable);
    await pool.query(createCompaniesTable);
    await pool.query(createFinancialMetricsTable);
    await pool.query(createIndexes);
    console.log('Database tables created successfully');
  } catch (error) {
    console.error('Error creating database tables:', error);
  }
};

// Initialize database on startup
createTables();

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// ========================================
// PACKAGE.JSON FOR BACKEND
// ========================================
/*
{
  "name": "industry-intelligence-backend",
  "version": "1.0.0",
  "description": "Backend API for Industry Intelligence Platform",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "stripe": "^12.0.0",
    "pg": "^8.11.0",
    "dotenv": "^16.0.3"
  },
  "devDependencies": {
    "nodemon": "^2.0.22"
  }
}
*/

// ========================================
// ENVIRONMENT VARIABLES (.env)
// ========================================
/*
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_here

# Database Configuration
DATABASE_URL=postgresql://username:password@localhost:5432/industry_intelligence

# Application Configuration
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://your-frontend-domain.com

# API Keys for Data Sources
ALPHA_VANTAGE_API_KEY=your_alpha_vantage_key
FRED_API_KEY=your_fred_api_key
NEWS_API_KEY=your_news_api_key
YAHOO_FINANCE_API_KEY=your_yahoo_finance_key

# Premium Data Source Keys (for paid users)
BLOOMBERG_API_KEY=your_bloomberg_key
REFINITIV_API_KEY=your_refinitiv_key
SP_CAPITAL_IQ_KEY=your_sp_key
*/
