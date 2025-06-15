import crypto from 'crypto';

/**
 * Verifies the authenticity of a Shopify webhook by validating the HMAC signature
 * @param rawBody - The raw request body as a Buffer
 * @param signature - The x-shopify-hmac-sha256 header value
 * @param secret - The webhook secret from Shopify
 * @returns boolean indicating if the signature is valid
 */
export function verifyShopifyWebhook(
  rawBody: Buffer,
  signature: string,
  secret: string
): boolean {
  try {
    // Remove 'sha256=' prefix if present
    const cleanSignature = signature.replace(/^sha256=/, '');
    
    // Create HMAC using the webhook secret
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const computedHash = hmac.digest('base64');
    
    // Compare the computed hash with the provided signature
    return crypto.timingSafeEqual(
      Buffer.from(computedHash, 'base64'),
      Buffer.from(cleanSignature, 'base64')
    );
  } catch (error) {
    console.error('Error verifying Shopify webhook signature:', error);
    return false;
  }
}

/**
 * Type definition for Shopify order webhook payload
 */
export interface ShopifyOrder {
  id: number;
  order_number: number;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  currency: string;
  financial_status: string;
  fulfillment_status: string | null;
  note?: string;
  order_status_url?: string;
  customer: {
    id: number;
    first_name: string;
    last_name: string;
    email: string;
    phone: string | null;
  };
  shipping_address: {
    first_name: string;
    last_name: string;
    address1: string;
    address2: string | null;
    city: string;
    province: string;
    country: string;
    zip: string;
    phone: string | null;
  } | null;
  line_items: Array<{
    id: number;
    title: string;
    quantity: number;
    price: string;
    variant_title: string | null;
    product_id: number;
    variant_id: number;
  }>;
} 