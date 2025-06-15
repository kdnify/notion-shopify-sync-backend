# Automatic Notion Database Creation

This backend now supports automatically creating new Notion databases from a template for each user/shop.

## Environment Variables Required

Add these to your `.env` file:

```env
# Existing variables
NOTION_TOKEN=secret_your_notion_integration_token
NOTION_DB_ID=your_default_notion_database_id

# New variables for template functionality
NOTION_TEMPLATE_DB_ID=your_template_database_id
NOTION_PARENT_PAGE_ID=your_parent_page_id_optional
```

## API Endpoints

### POST /notion/create-db
Creates a new Notion database from template for a specific shop.

**Request Body:**
```json
{
  "shopDomain": "teststore.myshopify.com",
  "email": "user@example.com" // optional
}
```

**Response:**
```json
{
  "success": true,
  "dbId": "new_database_id",
  "message": "Successfully created Notion database for teststore",
  "shopName": "teststore",
  "shopDomain": "teststore.myshopify.com"
}
```

### GET /notion/test-template
Tests access to the template database.

**Response:**
```json
{
  "success": true,
  "message": "Template database is accessible",
  "templateId": "template_db_id",
  "templateTitle": "Order Tracker Template",
  "propertyCount": 12
}
```

### GET /notion/db-info/:dbId
Gets information about a specific database.

**Response:**
```json
{
  "success": true,
  "dbId": "database_id",
  "title": "Shopify Orders: teststore",
  "propertyCount": 12,
  "createdTime": "2024-01-01T00:00:00.000Z",
  "lastEditedTime": "2024-01-01T00:00:00.000Z"
}
```

## Setup Instructions

1. **Create a Template Database:**
   - Create a Notion database with all the properties you want (Order Number, Customer, Total, etc.)
   - Copy the database ID from the URL
   - Set `NOTION_TEMPLATE_DB_ID` to this ID

2. **Set Parent Page (Optional):**
   - Create a parent page where new databases will be created
   - Copy the page ID from the URL
   - Set `NOTION_PARENT_PAGE_ID` to this ID
   - If not set, databases will be created at the root level

3. **Integration Permissions:**
   - Make sure your Notion integration has access to:
     - The template database (read permissions)
     - The parent page (write permissions)
     - Ability to create new databases

## Usage Flow

1. User installs the Shopify app
2. App calls `POST /notion/create-db` with the shop domain
3. Backend duplicates the template database
4. New database is titled "Shopify Orders: {shopname}"
5. Database ID is stored for the user
6. Future orders sync to the user's personal database

## Error Handling

The API includes comprehensive error handling for:
- Missing environment variables
- Template database access issues
- Database creation failures
- Permission problems
- Invalid shop domains

## Testing

Test the template setup:
```bash
curl https://your-backend.com/notion/test-template
```

Create a database for testing:
```bash
curl -X POST https://your-backend.com/notion/create-db \
  -H "Content-Type: application/json" \
  -d '{"shopDomain": "teststore.myshopify.com"}'
``` 