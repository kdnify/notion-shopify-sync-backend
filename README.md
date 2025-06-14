# Notion Shopify Sync Backend

A TypeScript Express.js server that receives Shopify webhooks and syncs order data to Notion databases.

## Features

- ✅ **Webhook Security**: Validates Shopify HMAC signatures
- 📦 **Order Processing**: Extracts and formats Shopify order data
- 🗄️ **Notion Integration**: Creates structured pages in Notion databases
- 🛡️ **Error Handling**: Comprehensive error handling and logging
- 🧪 **Testing**: Built-in test endpoints for validation

## Setup

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Environment Configuration

Create a `.env` file in the backend directory:

```env
# Shopify Configuration
SHOPIFY_WEBHOOK_SECRET=cc861dd0896f9444999bea28188fd64e

# Notion Configuration
NOTION_TOKEN=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
NOTION_DB_ID=212e8f5ac14a807fb67ac1887df275d5

# Server Configuration
PORT=3001
NODE_ENV=development
```

### 3. Notion Database Setup

Your Notion database should have the following properties:

- **Name** (Title)
- **Order Number** (Number)
- **Order ID** (Rich Text)
- **Customer** (Rich Text)
- **Email** (Email)
- **Total** (Number)
- **Currency** (Select)
- **Financial Status** (Select)
- **Fulfillment Status** (Select)
- **Created At** (Date)
- **Line Items** (Rich Text)
- **Shipping Address** (Rich Text)

### 4. Shopify Webhook Setup

1. Go to your Shopify Admin → Settings → Notifications
2. Add a new webhook:
   - **Event**: Order creation
   - **Format**: JSON
   - **URL**: `https://your-domain.com/webhooks/orders`
   - **Secret**: Use the same value as `SHOPIFY_WEBHOOK_SECRET`

## Development

```bash
# Start development server with hot reload
npm run dev

# Build for production
npm run build

# Start production server
npm run start

# Clean build directory
npm run clean
```

## API Endpoints

### POST `/webhooks/orders`
Receives Shopify order creation webhooks.

**Headers:**
- `x-shopify-hmac-sha256`: Required signature for verification

**Response:**
```json
{
  "success": true,
  "message": "Order successfully synced to Notion",
  "data": {
    "orderId": 12345,
    "orderNumber": 1001,
    "notionPageId": "page-id"
  }
}
```

### GET `/webhooks/test`
Tests webhook configuration and Notion connection.

**Response:**
```json
{
  "status": "OK",
  "message": "All webhook tests passed successfully",
  "checks": {
    "shopifySecret": true,
    "notionToken": true,
    "notionDbId": true,
    "notionConnection": true
  }
}
```

### GET `/health`
Health check endpoint.

**Response:**
```json
{
  "status": "OK",
  "message": "Notion Shopify Sync Backend is running",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Project Structure

```
backend/
├── src/
│   ├── index.ts              # Main server entry point
│   ├── routes/
│   │   └── webhooks.ts      # Webhook route handlers
│   ├── services/
│   │   └── notion.ts        # Notion API service
│   └── utils/
│       └── verifyShopify.ts # Shopify signature verification
├── package.json
├── tsconfig.json
├── nodemon.json
└── .env                     # Environment variables
```

## Security

- **HMAC Verification**: All webhooks are verified using Shopify's HMAC signature
- **Environment Variables**: Sensitive data stored in environment variables
- **Helmet**: Security headers applied to all responses
- **Error Handling**: Detailed errors only shown in development mode

## Logging

The server provides detailed console logging:
- 📦 Webhook reception
- ✅ Signature verification
- 📝 Order processing
- 🎉 Successful sync
- ❌ Error conditions

## Troubleshooting

### Common Issues

1. **Invalid Signature**: Check that `SHOPIFY_WEBHOOK_SECRET` matches your Shopify webhook secret
2. **Notion Connection Failed**: Verify `NOTION_TOKEN` and `NOTION_DB_ID` are correct
3. **Database Property Mismatch**: Ensure your Notion database has all required properties

### Testing

Use the test endpoint to verify your setup:

```bash
curl http://localhost:3001/webhooks/test
```

## Production Deployment

1. Set `NODE_ENV=production`
2. Build the project: `npm run build`
3. Start with: `npm start`
4. Use a process manager like PM2 for production
5. Set up HTTPS (required for Shopify webhooks)
6. Configure proper logging and monitoring 