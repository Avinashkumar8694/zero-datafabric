/**
 * Generates the 13 incremental metadata manifests for payment-ms schema evolution
 */
const fs = require('fs');
const path = require('path');

const manifestsDir = path.join(__dirname, 'manifests');
if (!fs.existsSync(manifestsDir)) {
  fs.mkdirSync(manifestsDir, { recursive: true });
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Base Schema (Step 00) ───────────────────────────────────────────────────
const enums00 = [
  { type: 'ENUM', name: 'tenant_status_enum', values: ['active', 'suspended', 'deleted'] },
  { type: 'ENUM', name: 'tenant_plan_enum', values: ['free', 'starter', 'pro', 'enterprise'] },
  { type: 'ENUM', name: 'member_role_enum', values: ['system_admin', 'owner', 'admin', 'developer', 'finance', 'viewer'] },
  { type: 'ENUM', name: 'member_status_enum', values: ['pending', 'active', 'disabled'] },
  { type: 'ENUM', name: 'payment_status_enum', values: ['created', 'pending', 'authorized', 'captured', 'completed', 'failed', 'cancelled', 'refunded', 'partially_refunded', 'expired'] },
  { type: 'ENUM', name: 'payment_method_enum', values: ['card', 'upi', 'netbanking', 'wallet', 'emi', 'bank_transfer'] },
  { type: 'ENUM', name: 'payment_provider_type_enum', values: ['razorpay', 'stripe', 'paypal', 'cashfree', 'phonepe', 'tappay', 'hyperpay', 'ccavenue'] },
  { type: 'ENUM', name: 'refund_status_enum', values: ['pending', 'pending_approval', 'approved', 'rejected', 'processing', 'completed', 'failed'] },
  { type: 'ENUM', name: 'refund_reason_enum', values: ['customer_request', 'duplicate', 'fraudulent', 'order_cancelled', 'product_not_delivered', 'product_defective', 'other'] },
  { type: 'ENUM', name: 'api_key_status_enum', values: ['active', 'revoked'] },
  { type: 'ENUM', name: 'api_key_type_enum', values: ['live', 'test'] },
  { type: 'ENUM', name: 'audit_event_category_enum', values: ['authentication', 'data_modification', 'payments', 'refunds', 'api_keys', 'providers', 'team', 'tenant', 'security', 'other'] },
  { type: 'ENUM', name: 'actor_type_enum', values: ['user', 'api_key', 'system', 'webhook'] },
  { type: 'ENUM', name: 'webhook_status_enum', values: ['active', 'disabled', 'failed'] }
];

const tables00 = [
  {
    type: 'TABLE',
    name: 'tenants',
    columns: [
      { name: 'id', type: 'STRING', length: 50, primaryKey: true },
      { name: 'name', type: 'STRING', length: 255 },
      { name: 'slug', type: 'STRING', length: 100, unique: true },
      { name: 'status', type: 'ENUM', ref: 'tenant_status_enum', default: 'active' },
      { name: 'plan', type: 'ENUM', ref: 'tenant_plan_enum', default: 'free' },
      { name: 'settings', type: 'JSONB' },
      { name: 'billing', type: 'JSONB' },
      { name: 'ownerUserId', type: 'STRING', length: 255 },
      { name: 'ownerEmail', type: 'STRING', length: 255 },
      { name: 'metadata', type: 'JSONB' },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'deletedAt', type: 'TIMESTAMP' }
    ]
  },
  {
    type: 'TABLE',
    name: 'roles',
    columns: [
      { name: 'id', type: 'STRING', length: 50, primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'name', type: 'STRING', length: 100 },
      { name: 'description', type: 'STRING', length: 500 },
      { name: 'permissions', type: 'JSONB' },
      { name: 'isDefault', type: 'BOOLEAN', default: 'false' },
      { name: 'createdBy', type: 'STRING', length: 255 },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  },
  {
    type: 'TABLE',
    name: 'tenant_members',
    columns: [
      { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'userId', type: 'STRING', length: 255 },
      { name: 'email', type: 'STRING', length: 255 },
      { name: 'displayName', type: 'STRING', length: 255 },
      { name: 'avatarUrl', type: 'STRING', length: 500 },
      { name: 'role', type: 'ENUM', ref: 'member_role_enum', default: 'viewer' },
      { name: 'status', type: 'ENUM', ref: 'member_status_enum', default: 'pending' },
      { name: 'customPermissions', type: 'JSONB' },
      { name: 'roleId', type: 'STRING', length: 50 },
      { name: 'invitedBy', type: 'STRING', length: 255 },
      { name: 'invitationToken', type: 'STRING', length: 128 },
      { name: 'invitationExpiry', type: 'TIMESTAMP' },
      { name: 'acceptedAt', type: 'TIMESTAMP' },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  },
  {
    type: 'TABLE',
    name: 'api_keys',
    columns: [
      { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'name', type: 'STRING', length: 100 },
      { name: 'prefix', type: 'STRING', length: 16 },
      { name: 'hash', type: 'STRING', length: 128 },
      { name: 'permissions', type: 'JSONB' },
      { name: 'type', type: 'ENUM', ref: 'api_key_type_enum', default: 'live' },
      { name: 'status', type: 'ENUM', ref: 'api_key_status_enum', default: 'active' },
      { name: 'expiresAt', type: 'TIMESTAMP' },
      { name: 'lastUsedAt', type: 'TIMESTAMP' },
      { name: 'createdBy', type: 'STRING', length: 255 },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'revokedAt', type: 'TIMESTAMP' },
      { name: 'revokedBy', type: 'STRING', length: 255 }
    ]
  },
  {
    type: 'TABLE',
    name: 'provider_configs',
    columns: [
      { name: 'id', type: 'STRING', length: 50, primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'provider', type: 'ENUM', ref: 'payment_provider_type_enum' },
      { name: 'name', type: 'STRING', length: 100 },
      { name: 'isEnabled', type: 'BOOLEAN', default: 'true' },
      { name: 'isDefault', type: 'BOOLEAN', default: 'false' },
      { name: 'mode', type: 'ENUM', ref: 'api_key_type_enum', default: 'live' },
      { name: 'credentials', type: 'JSONB' },
      { name: 'webhookSecret', type: 'STRING', length: 255 },
      { name: 'webhookUrl', type: 'STRING', length: 500 },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  },
  {
    type: 'TABLE',
    name: 'payments',
    columns: [
      { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'orderId', type: 'STRING', length: 100 },
      { name: 'amount', type: 'NUMERIC' },
      { name: 'currency', type: 'STRING', length: 10, default: 'INR' },
      { name: 'status', type: 'ENUM', ref: 'payment_status_enum', default: 'created' },
      { name: 'provider', type: 'ENUM', ref: 'payment_provider_type_enum' },
      { name: 'providerPaymentId', type: 'STRING', length: 255 },
      { name: 'providerOrderId', type: 'STRING', length: 255 },
      { name: 'providerConfigId', type: 'STRING', length: 50 },
      { name: 'customerId', type: 'STRING', length: 255 },
      { name: 'customerEmail', type: 'STRING', length: 255 },
      { name: 'customerPhone', type: 'STRING', length: 50 },
      { name: 'paymentMethod', type: 'ENUM', ref: 'payment_method_enum' },
      { name: 'paymentMethodDetails', type: 'JSONB' },
      { name: 'description', type: 'STRING', length: 500 },
      { name: 'metadata', type: 'JSONB' },
      { name: 'clientReturnUrl', type: 'STRING', length: 500 },
      { name: 'clientCallbackUrl', type: 'STRING', length: 500 },
      { name: 'errorMessage', type: 'TEXT' },
      { name: 'errorCode', type: 'STRING', length: 50 },
      { name: 'authorizedAt', type: 'TIMESTAMP' },
      { name: 'capturedAt', type: 'TIMESTAMP' },
      { name: 'failedAt', type: 'TIMESTAMP' },
      { name: 'cancelledAt', type: 'TIMESTAMP' },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  },
  {
    type: 'TABLE',
    name: 'refunds',
    columns: [
      { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'paymentId', type: 'UUID' },
      { name: 'refundId', type: 'STRING', length: 100 },
      { name: 'amount', type: 'NUMERIC' },
      { name: 'currency', type: 'STRING', length: 10, default: 'INR' },
      { name: 'status', type: 'ENUM', ref: 'refund_status_enum', default: 'pending' },
      { name: 'reason', type: 'ENUM', ref: 'refund_reason_enum' },
      { name: 'providerRefundId', type: 'STRING', length: 255 },
      { name: 'notes', type: 'TEXT' },
      { name: 'metadata', type: 'JSONB' },
      { name: 'requestedBy', type: 'STRING', length: 255 },
      { name: 'approvedBy', type: 'STRING', length: 255 },
      { name: 'approvedAt', type: 'TIMESTAMP' },
      { name: 'rejectedAt', type: 'TIMESTAMP' },
      { name: 'rejectionReason', type: 'TEXT' },
      { name: 'processedAt', type: 'TIMESTAMP' },
      { name: 'failedAt', type: 'TIMESTAMP' },
      { name: 'failureReason', type: 'TEXT' },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  },
  {
    type: 'TABLE',
    name: 'webhooks',
    columns: [
      { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'url', type: 'STRING', length: 500 },
      { name: 'secret', type: 'STRING', length: 255 },
      { name: 'events', type: 'JSONB' },
      { name: 'status', type: 'ENUM', ref: 'webhook_status_enum', default: 'active' },
      { name: 'description', type: 'STRING', length: 500 },
      { name: 'metadata', type: 'JSONB' },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  },
  {
    type: 'TABLE',
    name: 'webhook_delivery_logs',
    columns: [
      { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'webhookId', type: 'UUID' },
      { name: 'eventType', type: 'STRING', length: 100 },
      { name: 'payload', type: 'JSONB' },
      { name: 'responseStatus', type: 'INT' },
      { name: 'responseBody', type: 'TEXT' },
      { name: 'executionTimeMs', type: 'INT' },
      { name: 'status', type: 'STRING', length: 50 },
      { name: 'attempt', type: 'INT', default: '1' },
      { name: 'nextRetryAt', type: 'TIMESTAMP' },
      { name: 'error', type: 'TEXT' },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  },
  {
    type: 'TABLE',
    name: 'audit_logs',
    columns: [
      { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'actorId', type: 'STRING', length: 255 },
      { name: 'actorType', type: 'ENUM', ref: 'actor_type_enum' },
      { name: 'actorEmail', type: 'STRING', length: 255 },
      { name: 'category', type: 'ENUM', ref: 'audit_event_category_enum' },
      { name: 'action', type: 'STRING', length: 100 },
      { name: 'resourceType', type: 'STRING', length: 100 },
      { name: 'resourceId', type: 'STRING', length: 255 },
      { name: 'ipAddress', type: 'STRING', length: 45 },
      { name: 'userAgent', type: 'STRING', length: 500 },
      { name: 'details', type: 'JSONB' },
      { name: 'timestamp', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  },
  {
    type: 'TABLE',
    name: 'api_clients',
    columns: [
      { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'name', type: 'STRING', length: 100 },
      { name: 'clientId', type: 'STRING', length: 100 },
      { name: 'clientSecretHash', type: 'STRING', length: 128 },
      { name: 'permissions', type: 'JSONB' },
      { name: 'isActive', type: 'BOOLEAN', default: 'true' },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  },
  {
    type: 'TABLE',
    name: 'ip_block_entries',
    columns: [
      { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'ipOrCidr', type: 'STRING', length: 255 },
      { name: 'reason', type: 'STRING', length: 500 },
      { name: 'blockedBy', type: 'STRING', length: 255 },
      { name: 'expiresAt', type: 'TIMESTAMP' },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  },
  {
    type: 'TABLE',
    name: 'cashback_rules',
    columns: [
      { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'name', type: 'STRING', length: 100 },
      { name: 'description', type: 'STRING', length: 500 },
      { name: 'isActive', type: 'BOOLEAN', default: 'true' },
      { name: 'priority', type: 'INT', default: '0' },
      { name: 'conditions', type: 'JSONB' },
      { name: 'rewardType', type: 'STRING', length: 50 },
      { name: 'rewardValue', type: 'NUMERIC' },
      { name: 'minOrderAmount', type: 'NUMERIC' },
      { name: 'maxRewardAmount', type: 'NUMERIC' },
      { name: 'maxUsagePerCustomer', type: 'INT' },
      { name: 'totalUsageLimit', type: 'INT' },
      { name: 'currentUsageCount', type: 'INT', default: '0' },
      { name: 'validFrom', type: 'TIMESTAMP' },
      { name: 'validTo', type: 'TIMESTAMP' },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  },
  {
    type: 'TABLE',
    name: 'cashback_ledger_entries',
    columns: [
      { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
      { name: 'tenantId', type: 'STRING', length: 50 },
      { name: 'customerId', type: 'STRING', length: 255 },
      { name: 'ruleId', type: 'UUID' },
      { name: 'paymentId', type: 'UUID' },
      { name: 'amount', type: 'NUMERIC' },
      { name: 'status', type: 'STRING', length: 50 },
      { name: 'notes', type: 'TEXT' },
      { name: 'expiresAt', type: 'TIMESTAMP' },
      { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
      { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
    ]
  }
];

const relationships00 = [
  { name: 'rel_roles_tenant', cardinality: '1:M', from: { resource: 'tenants', field: 'id' }, to: { resource: 'roles', field: 'tenantId' } },
  { name: 'rel_tenant_members', cardinality: '1:M', from: { resource: 'tenants', field: 'id' }, to: { resource: 'tenant_members', field: 'tenantId' } },
  { name: 'rel_tenant_payments', cardinality: '1:M', from: { resource: 'tenants', field: 'id' }, to: { resource: 'payments', field: 'tenantId' } },
  { name: 'rel_payment_refunds', cardinality: '1:M', from: { resource: 'payments', field: 'id' }, to: { resource: 'refunds', field: 'paymentId' } },
  { name: 'rel_tenant_webhooks', cardinality: '1:M', from: { resource: 'tenants', field: 'id' }, to: { resource: 'webhooks', field: 'tenantId' } }
];

function buildManifest(resources, rels = relationships00) {
  return {
    version: '4.0',
    namespace: 'Payment_MS',
    targetSource: 'Fabric_Hub_Postgres',
    schemas: [
      {
        name: 'Payment_MS',
        targetSource: 'Fabric_Hub_Postgres',
        resources: clone(resources)
      }
    ],
    relationships: clone(rels)
  };
}

// ── Build Manifests Array ───────────────────────────────────────────────────
const steps = [];

// Step 00: Initial Schema
const m00 = buildManifest([...enums00, ...tables00]);
steps.push({ name: '00-initial-schema', manifest: m00 });

// Step 01: Checkout Token & Provider Channel
// Add payments.checkoutToken (STRING 128 UNIQUE), provider_configs.channel (STRING 50)
const m01 = clone(m00);
const payments01 = m01.schemas[0].resources.find(r => r.name === 'payments');
payments01.columns.push({ name: 'checkoutToken', type: 'STRING', length: 128, unique: true });
const pconf01 = m01.schemas[0].resources.find(r => r.name === 'provider_configs');
pconf01.columns.push({ name: 'channel', type: 'STRING', length: 50 });
steps.push({ name: '01-checkout-token', manifest: m01 });

// Step 02: Disputes, Capture & Webhook Durability
// Add dispute_status_enum, disputes table, payments capture cols, webhooks durability cols
const m02 = clone(m01);
m02.schemas[0].resources.push({
  type: 'ENUM',
  name: 'dispute_status_enum',
  values: ['needs_response', 'under_review', 'won', 'lost', 'closed']
});
m02.schemas[0].resources.push({
  type: 'TABLE',
  name: 'disputes',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'paymentId', type: 'UUID' },
    { name: 'disputeId', type: 'STRING', length: 100 },
    { name: 'amount', type: 'NUMERIC' },
    { name: 'currency', type: 'STRING', length: 10, default: 'INR' },
    { name: 'status', type: 'ENUM', ref: 'dispute_status_enum', default: 'needs_response' },
    { name: 'reason', type: 'STRING', length: 255 },
    { name: 'evidence', type: 'JSONB' },
    { name: 'responseDueAt', type: 'TIMESTAMP' },
    { name: 'resolvedAt', type: 'TIMESTAMP' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
    { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});
m02.relationships.push({
  name: 'rel_payment_disputes',
  cardinality: '1:M',
  from: { resource: 'payments', field: 'id' },
  to: { resource: 'disputes', field: 'paymentId' }
});
const payments02 = m02.schemas[0].resources.find(r => r.name === 'payments');
payments02.columns.push(
  { name: 'autoCapture', type: 'BOOLEAN', default: 'true' },
  { name: 'capturedAmount', type: 'NUMERIC' },
  { name: 'authorizedAmount', type: 'NUMERIC' },
  { name: 'providerFee', type: 'NUMERIC' },
  { name: 'capturedBy', type: 'STRING', length: 255 }
);
const webhooks02 = m02.schemas[0].resources.find(r => r.name === 'webhooks');
webhooks02.columns.push(
  { name: 'failureCount', type: 'INT', default: '0' },
  { name: 'lastError', type: 'TEXT' },
  { name: 'lastSuccessAt', type: 'TIMESTAMP' },
  { name: 'lastFailureAt', type: 'TIMESTAMP' },
  { name: 'disabledAt', type: 'TIMESTAMP' }
);
steps.push({ name: '02-disputes-and-capture', manifest: m02 });

// Step 03: Tenant Pending Verification
// Add 'pending_verification' to tenant_status_enum
const m03 = clone(m02);
const tenantStatusEnum03 = m03.schemas[0].resources.find(r => r.name === 'tenant_status_enum');
tenantStatusEnum03.values.push('pending_verification');
steps.push({ name: '03-tenant-pending-verification', manifest: m03 });

// Step 04: Customer Identity & Refund Rules
// Add customers and refund_rules tables
const m04 = clone(m03);
m04.schemas[0].resources.push({
  type: 'TABLE',
  name: 'customers',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'customerId', type: 'STRING', length: 255 },
    { name: 'email', type: 'STRING', length: 255 },
    { name: 'phone', type: 'STRING', length: 50 },
    { name: 'name', type: 'STRING', length: 255 },
    { name: 'metadata', type: 'JSONB' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
    { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});
m04.schemas[0].resources.push({
  type: 'TABLE',
  name: 'refund_rules',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'name', type: 'STRING', length: 100 },
    { name: 'description', type: 'STRING', length: 500 },
    { name: 'isActive', type: 'BOOLEAN', default: 'true' },
    { name: 'priority', type: 'INT', default: '0' },
    { name: 'ruleType', type: 'STRING', length: 50 },
    { name: 'deductionType', type: 'STRING', length: 50 },
    { name: 'deductionValue', type: 'NUMERIC' },
    { name: 'conditions', type: 'JSONB' },
    { name: 'validFrom', type: 'TIMESTAMP' },
    { name: 'validTo', type: 'TIMESTAMP' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
    { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});
m04.relationships.push({
  name: 'rel_tenant_customers',
  cardinality: '1:M',
  from: { resource: 'tenants', field: 'id' },
  to: { resource: 'customers', field: 'tenantId' }
});
steps.push({ name: '04-customer-identity-refund-rules', manifest: m04 });

// Step 05: Production Hardening
// Alter webhooks.secret (255 -> 500)
// Alter ip_block_entries.ipOrCidr (255 -> 45)
// Add payments fraud columns
// Add payment_links table
const m05 = clone(m04);
const webhooks05 = m05.schemas[0].resources.find(r => r.name === 'webhooks');
const secretCol05 = webhooks05.columns.find(c => c.name === 'secret');
secretCol05.length = 500;

const ipEntries05 = m05.schemas[0].resources.find(r => r.name === 'ip_block_entries');
const ipCol05 = ipEntries05.columns.find(c => c.name === 'ipOrCidr');
ipCol05.length = 45;

const payments05 = m05.schemas[0].resources.find(r => r.name === 'payments');
payments05.columns.push(
  { name: 'customerIp', type: 'STRING', length: 45 },
  { name: 'paymentLinkId', type: 'UUID' },
  { name: 'manualReviewStatus', type: 'STRING', length: 50 },
  { name: 'manualReviewNotes', type: 'TEXT' },
  { name: 'manualReviewedBy', type: 'STRING', length: 255 },
  { name: 'manualReviewedAt', type: 'TIMESTAMP' }
);

m05.schemas[0].resources.push({
  type: 'TABLE',
  name: 'payment_links',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'title', type: 'STRING', length: 255 },
    { name: 'description', type: 'STRING', length: 500 },
    { name: 'amount', type: 'NUMERIC' },
    { name: 'currency', type: 'STRING', length: 10, default: 'INR' },
    { name: 'status', type: 'STRING', length: 50, default: 'active' },
    { name: 'shortCode', type: 'STRING', length: 50, unique: true },
    { name: 'expiresAt', type: 'TIMESTAMP' },
    { name: 'maxUses', type: 'INT' },
    { name: 'currentUses', type: 'INT', default: '0' },
    { name: 'metadata', type: 'JSONB' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
    { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});
steps.push({ name: '05-production-hardening', manifest: m05 });

// Step 06: Payment Method Selection
// Add payment_links.allowedMethods (JSONB), payment_links.enforceMethods (BOOLEAN)
const m06 = clone(m05);
const pl06 = m06.schemas[0].resources.find(r => r.name === 'payment_links');
pl06.columns.push(
  { name: 'allowedMethods', type: 'JSONB' },
  { name: 'enforceMethods', type: 'BOOLEAN', default: 'false' }
);
steps.push({ name: '06-payment-method-selection', manifest: m06 });

// Step 07: Provider Soft Delete
// Add provider_configs.deletedAt (TIMESTAMP)
const m07 = clone(m06);
const pconf07 = m07.schemas[0].resources.find(r => r.name === 'provider_configs');
pconf07.columns.push({ name: 'deletedAt', type: 'TIMESTAMP' });
steps.push({ name: '07-provider-soft-delete', manifest: m07 });

// Step 08: Money Hardening
// Add payments.requestHash (STRING 64)
// Add refunds.idempotencyKey (STRING 128), refunds.requestHash (STRING 64)
const m08 = clone(m07);
const payments08 = m08.schemas[0].resources.find(r => r.name === 'payments');
payments08.columns.push({ name: 'requestHash', type: 'STRING', length: 64 });
const refunds08 = m08.schemas[0].resources.find(r => r.name === 'refunds');
refunds08.columns.push(
  { name: 'idempotencyKey', type: 'STRING', length: 128 },
  { name: 'requestHash', type: 'STRING', length: 64 }
);
steps.push({ name: '08-money-hardening', manifest: m08 });

// Step 09: Provider Callback Forwarding
// Add webhooks.providerConfigId (STRING 50)
const m09 = clone(m08);
const webhooks09 = m09.schemas[0].resources.find(r => r.name === 'webhooks');
webhooks09.columns.push({ name: 'providerConfigId', type: 'STRING', length: 50 });
steps.push({ name: '09-provider-callback-forwarding', manifest: m09 });

// Step 10: Plans & Trials
// Add plans and plan_requests tables
// Alter tenants.plan from ENUM to STRING (length: 50)
// Add tenants trial columns
const m10 = clone(m09);
m10.schemas[0].resources.push({
  type: 'TABLE',
  name: 'plans',
  columns: [
    { name: 'id', type: 'STRING', length: 50, primaryKey: true },
    { name: 'name', type: 'STRING', length: 100 },
    { name: 'description', type: 'STRING', length: 500 },
    { name: 'limits', type: 'JSONB' },
    { name: 'trialDays', type: 'INT', default: '7' },
    { name: 'status', type: 'STRING', length: 50, default: 'active' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
    { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});
m10.schemas[0].resources.push({
  type: 'TABLE',
  name: 'plan_requests',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'planId', type: 'STRING', length: 50 },
    { name: 'status', type: 'STRING', length: 50, default: 'pending' },
    { name: 'contactEmail', type: 'STRING', length: 255 },
    { name: 'message', type: 'TEXT' },
    { name: 'requestedAt', type: 'TIMESTAMP', default: 'NOW()' },
    { name: 'respondedAt', type: 'TIMESTAMP' }
  ]
});
const tenants10 = m10.schemas[0].resources.find(r => r.name === 'tenants');
const planCol10 = tenants10.columns.find(c => c.name === 'plan');
planCol10.type = 'STRING';
planCol10.length = 50;
delete planCol10.ref;
tenants10.columns.push(
  { name: 'planStartedAt', type: 'TIMESTAMP' },
  { name: 'planExpiresAt', type: 'TIMESTAMP' },
  { name: 'planOverrides', type: 'JSONB' },
  { name: 'trialUsedAt', type: 'TIMESTAMP' }
);
steps.push({ name: '10-plans-and-trials', manifest: m10 });

// Step 11: Hide Legacy Plans
// Manifest is identical to Step 10; step runner executes data migration / updates on plans table
const m11 = clone(m10);
steps.push({ name: '11-hide-legacy-plans', manifest: m11 });

// Step 12: Background Jobs
// Add background_jobs, background_job_runs, and job_queue_items
const m12 = clone(m11);
m12.schemas[0].resources.push({
  type: 'TABLE',
  name: 'background_jobs',
  columns: [
    { name: 'id', type: 'STRING', length: 100, primaryKey: true },
    { name: 'schedule', type: 'STRING', length: 100 },
    { name: 'batchSize', type: 'INT', default: '100' },
    { name: 'concurrency', type: 'INT', default: '1' },
    { name: 'timeoutMs', type: 'INT', default: '60000' },
    { name: 'rateLimitQuota', type: 'STRING', length: 50, default: '1000' },
    { name: 'autoRetry', type: 'STRING', length: 10, default: 'true' },
    { name: 'lastRunAt', type: 'TIMESTAMP' },
    { name: 'cursor', type: 'STRING', length: 255 },
    { name: 'isEnabled', type: 'BOOLEAN', default: 'true' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
    { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});
m12.schemas[0].resources.push({
  type: 'TABLE',
  name: 'background_job_runs',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'jobId', type: 'STRING', length: 100 },
    { name: 'status', type: 'STRING', length: 50 },
    { name: 'startedAt', type: 'TIMESTAMP', default: 'NOW()' },
    { name: 'completedAt', type: 'TIMESTAMP' },
    { name: 'durationMs', type: 'INT' },
    { name: 'itemsProcessed', type: 'INT', default: '0' },
    { name: 'retryCountString', type: 'STRING', length: 20, default: '0' },
    { name: 'error', type: 'TEXT' },
    { name: 'metadata', type: 'JSONB' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});
m12.schemas[0].resources.push({
  type: 'TABLE',
  name: 'job_queue_items',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'jobType', type: 'STRING', length: 100 },
    { name: 'payload', type: 'JSONB' },
    { name: 'status', type: 'STRING', length: 50, default: 'pending' },
    { name: 'attempt', type: 'INT', default: '0' },
    { name: 'maxAttempts', type: 'INT', default: '5' },
    { name: 'priorityScore', type: 'STRING', length: 20, default: '100.00' },
    { name: 'scheduledFor', type: 'TIMESTAMP', default: 'NOW()' },
    { name: 'lockedAt', type: 'TIMESTAMP' },
    { name: 'completedAt', type: 'TIMESTAMP' },
    { name: 'error', type: 'TEXT' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' },
    { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});
steps.push({ name: '12-background-jobs', manifest: m12 });

// Step 13: Type Transformations (Comprehensive Cross-Type Schema Evolution)
// - String -> Number: rateLimitQuota (STRING -> INTEGER), retryCountString (STRING -> INTEGER), priorityScore (STRING -> NUMERIC)
// - Number -> String: batchSize (INT -> STRING 50), timeoutMs (INT -> STRING 50), refund_rules.priority (INT -> STRING 50)
// - Boolean -> String: isEnabled (BOOLEAN -> STRING 10)
// - String -> Boolean: autoRetry (STRING -> BOOLEAN)
// - Timestamp -> Date: completedAt (TIMESTAMP -> DATE)
const m13 = clone(m12);

// 1. Transform background_jobs columns
const bgJobs13 = m13.schemas[0].resources.find(r => r.name === 'background_jobs');
const batchSizeCol = bgJobs13.columns.find(c => c.name === 'batchSize');
batchSizeCol.type = 'STRING';
batchSizeCol.length = 50;

const timeoutCol = bgJobs13.columns.find(c => c.name === 'timeoutMs');
timeoutCol.type = 'STRING';
timeoutCol.length = 50;

const rateLimitCol = bgJobs13.columns.find(c => c.name === 'rateLimitQuota');
rateLimitCol.type = 'INTEGER';

const isEnabledCol = bgJobs13.columns.find(c => c.name === 'isEnabled');
isEnabledCol.type = 'STRING';
isEnabledCol.length = 10;

const autoRetryCol = bgJobs13.columns.find(c => c.name === 'autoRetry');
autoRetryCol.type = 'BOOLEAN';

// 2. Transform background_job_runs columns
const bgJobRuns13 = m13.schemas[0].resources.find(r => r.name === 'background_job_runs');
const retryCountCol = bgJobRuns13.columns.find(c => c.name === 'retryCountString');
retryCountCol.type = 'INTEGER';

const completedAtCol = bgJobRuns13.columns.find(c => c.name === 'completedAt');
completedAtCol.type = 'DATE';

// 3. Transform job_queue_items columns
const queueItems13 = m13.schemas[0].resources.find(r => r.name === 'job_queue_items');
const priorityScoreCol = queueItems13.columns.find(c => c.name === 'priorityScore');
priorityScoreCol.type = 'NUMERIC';

// 4. Transform refund_rules columns
const refundRules13 = m13.schemas[0].resources.find(r => r.name === 'refund_rules');
const rrPriorityCol = refundRules13.columns.find(c => c.name === 'priority');
rrPriorityCol.type = 'STRING';
rrPriorityCol.length = 50;

// 5. Add edge_case_records table with original baseline types
m13.schemas[0].resources.push({
  type: 'TABLE',
  name: 'edge_case_records',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'nullStrToInt', type: 'STRING', length: 50 },
    { name: 'nullNumToStr', type: 'INT' },
    { name: 'nullBoolToStr', type: 'BOOLEAN' },
    { name: 'nullTsToDate', type: 'TIMESTAMP' },
    { name: 'maxIntStr', type: 'STRING', length: 50 },
    { name: 'minIntStr', type: 'STRING', length: 50 },
    { name: 'bigIntStr', type: 'STRING', length: 50 },
    { name: 'highPrecisionStr', type: 'STRING', length: 50 },
    { name: 'negativeNumStr', type: 'STRING', length: 50 },
    { name: 'boolTrueStr', type: 'STRING', length: 10 },
    { name: 'boolFalseStr', type: 'STRING', length: 10 },
    { name: 'boolOneStr', type: 'STRING', length: 10 },
    { name: 'boolZeroStr', type: 'STRING', length: 10 },
    { name: 'jsonStr', type: 'TEXT' },
    { name: 'unicodeText', type: 'TEXT' }
  ]
});

steps.push({ name: '13-type-transformations', manifest: m13 });

// Step 14: Edge Cases & Boundaries
// Valid Edge Cases:
// - NULL preservation across all types (nullStrToInt, nullNumToStr, nullBoolToStr, nullTsToDate)
// - Boundary numeric extremes (INT4 Max 2147483647, INT4 Min -2147483648, BigInt 9223372036854775806, high precision decimal, negative decimal)
// - Boolean text variants ('true', 'false', '1', '0' -> BOOLEAN)
// - Complex JSON string -> native JSONB and JSON querying
// - Multi-lingual unicode & emoji preservation ('Payment 🚀 ₹50,000 日本語 "O\'Connor" ; DROP TABLE --')
const m14 = clone(m13);
const edgeCaseTable14 = m14.schemas[0].resources.find(r => r.name === 'edge_case_records');
edgeCaseTable14.columns.find(c => c.name === 'nullStrToInt').type = 'INTEGER';

const nullNumToStrCol = edgeCaseTable14.columns.find(c => c.name === 'nullNumToStr');
nullNumToStrCol.type = 'STRING';
nullNumToStrCol.length = 50;

const nullBoolToStrCol = edgeCaseTable14.columns.find(c => c.name === 'nullBoolToStr');
nullBoolToStrCol.type = 'STRING';
nullBoolToStrCol.length = 50;

edgeCaseTable14.columns.find(c => c.name === 'nullTsToDate').type = 'DATE';
edgeCaseTable14.columns.find(c => c.name === 'maxIntStr').type = 'INTEGER';
edgeCaseTable14.columns.find(c => c.name === 'minIntStr').type = 'INTEGER';
edgeCaseTable14.columns.find(c => c.name === 'bigIntStr').type = 'BIGINT';
edgeCaseTable14.columns.find(c => c.name === 'highPrecisionStr').type = 'NUMERIC';
edgeCaseTable14.columns.find(c => c.name === 'negativeNumStr').type = 'NUMERIC';
edgeCaseTable14.columns.find(c => c.name === 'boolTrueStr').type = 'BOOLEAN';
edgeCaseTable14.columns.find(c => c.name === 'boolFalseStr').type = 'BOOLEAN';
edgeCaseTable14.columns.find(c => c.name === 'boolOneStr').type = 'BOOLEAN';
edgeCaseTable14.columns.find(c => c.name === 'boolZeroStr').type = 'BOOLEAN';
edgeCaseTable14.columns.find(c => c.name === 'jsonStr').type = 'JSONB';

const unicodeCol = edgeCaseTable14.columns.find(c => c.name === 'unicodeText');
unicodeCol.type = 'STRING';
unicodeCol.length = 500;

steps.push({ name: '14-edge-cases-and-boundaries', manifest: m14 });

// Step 15: Views & Materialized Views (Advanced Analytical Engine)
// - Features Tested:
//   1. CTE (WITH RECURSIVE)
//   2. Window Functions: RANK, DENSE_RANK, ROW_NUMBER
//   3. Aggregates: COUNT, SUM, AVG, MAX, MIN
//   4. Multi-Table Relational JOINs (INNER, LEFT)
//   5. Computed Mathematical Expressions
//   6. WHERE, GROUP BY, HAVING, ORDER BY
//   7. Regular Declarative VIEW
//   8. Declarative MATERIALIZED VIEW with Secondary B-Tree Indexes
const m15 = clone(m14);

// 1. Declarative View: view_high_value_ranked_payments
m15.schemas[0].resources.push({
  type: 'VIEW',
  name: 'view_high_value_ranked_payments',
  query: {
    with: [
      {
        name: 'captured_payments',
        columns: ['id', 'tenantId', 'customerId', 'amount', 'currency', 'status'],
        base: {
          select: ['id', 'tenantId', 'customerId', 'amount', 'currency', 'status'],
          from: { resource: 'payments' },
          where: [{ column: 'status', operator: 'EQ', value: 'captured' }]
        }
      }
    ],
    select: [
      'cp.id',
      'cp.tenantId',
      't.name',
      'cp.amount',
      'cp.currency',
      { expression: 'cp.amount * 0.18', alias: 'estimated_tax' },
      { window: 'RANK', partitionBy: ['cp.tenantId'], orderBy: [{ column: 'cp.amount', direction: 'DESC' }], alias: 'payment_rank' },
      { window: 'DENSE_RANK', partitionBy: ['cp.tenantId'], orderBy: [{ column: 'cp.amount', direction: 'DESC' }], alias: 'payment_dense_rank' },
      { window: 'ROW_NUMBER', partitionBy: ['cp.tenantId'], orderBy: [{ column: 'cp.amount', direction: 'DESC' }], alias: 'payment_row_num' }
    ],
    from: { resource: 'captured_payments', alias: 'cp' },
    joins: [
      { type: 'INNER', resource: 'tenants', alias: 't', on: { left: 'cp.tenantId', operator: 'EQ', right: 't.id' } },
      { type: 'LEFT', resource: 'customers', alias: 'c', on: { left: 'cp.customerId', operator: 'EQ', right: 'c.customerId' } }
    ],
    orderBy: [{ column: 'cp.amount', direction: 'DESC' }]
  }
});

// 2. Declarative Materialized View: mv_tenant_revenue_analytics
m15.schemas[0].resources.push({
  type: 'MATERIALIZED_VIEW',
  name: 'mv_tenant_revenue_analytics',
  indexes: [
    { columns: ['tenantId'] },
    { columns: ['tenant_rank'] }
  ],
  query: {
    select: [
      'p.tenantId',
      't.name',
      { aggregate: 'COUNT', column: 'p.id', alias: 'total_payments' },
      { aggregate: 'SUM', column: 'p.amount', alias: 'total_revenue' },
      { aggregate: 'AVG', column: 'p.amount', alias: 'avg_ticket_size' },
      { aggregate: 'MAX', column: 'p.amount', alias: 'max_payment' },
      { aggregate: 'MIN', column: 'p.amount', alias: 'min_payment' },
      { window: 'RANK', orderBy: [{ column: 'p.tenantId', direction: 'ASC' }], alias: 'tenant_rank' }
    ],
    from: { resource: 'payments', alias: 'p' },
    joins: [
      { type: 'INNER', resource: 'tenants', alias: 't', on: { left: 'p.tenantId', operator: 'EQ', right: 't.id' } },
      { type: 'LEFT', resource: 'customers', alias: 'c', on: { left: 'p.customerId', operator: 'EQ', right: 'c.customerId' } }
    ],
    where: [
      { column: 'p.status', operator: 'EQ', value: 'captured' }
    ],
    groupBy: ['p.tenantId', 't.name'],
    having: [
      { column: 'total_revenue', operator: 'GT', value: 0 }
    ],
    orderBy: [{ column: 'total_revenue', direction: 'DESC' }]
  }
});

steps.push({ name: '15-views-and-materialized-views', manifest: m15 });

// ── Step 16: Sequences, Functions & Recursive Functions ──────────────────────
const m16 = clone(m15);

// 1. Sequence: seq_invoice_number
m16.schemas[0].resources.push({
  type: 'SEQUENCE',
  name: 'seq_invoice_number',
  start: 10001,
  increment: 1,
  minValue: 1,
  maxValue: 99999999,
  cache: 10
});

// 2. Sequence: seq_settlement_batch
m16.schemas[0].resources.push({
  type: 'SEQUENCE',
  name: 'seq_settlement_batch',
  start: 5000,
  increment: 10
});

// 3. Custom Scalar Function: calculate_processing_fee
m16.schemas[0].resources.push({
  type: 'FUNCTION',
  name: 'calculate_processing_fee',
  arguments: [
    { name: 'amount', type: 'NUMERIC', mode: 'IN' },
    { name: 'tier', type: 'STRING', mode: 'IN' }
  ],
  returnType: 'NUMERIC',
  body: `
    IF tier = 'enterprise' THEN
      RETURN ROUND(amount * 0.012 + 5.00, 2);
    ELSIF tier = 'growth' THEN
      RETURN ROUND(amount * 0.018 + 10.00, 2);
    ELSE
      RETURN ROUND(amount * 0.025 + 15.00, 2);
    END IF;
  `
});

// 4. Custom Recursive Function: calculate_referral_bonus
m16.schemas[0].resources.push({
  type: 'FUNCTION',
  name: 'calculate_referral_bonus',
  arguments: [
    { name: 'amount', type: 'NUMERIC', mode: 'IN' },
    { name: 'depth', type: 'INTEGER', mode: 'IN' }
  ],
  returnType: 'NUMERIC',
  body: `
    IF depth <= 1 THEN
      RETURN ROUND(amount * 0.05, 2);
    ELSE
      RETURN ROUND(amount * 0.05 * (1.0 / depth) + "tenant_tenant_A_Payment_MS".calculate_referral_bonus(amount, depth - 1), 2);
    END IF;
  `
});

// 5. Stored Procedure: mark_batch_settled
m16.schemas[0].resources.push({
  type: 'PROCEDURE',
  name: 'mark_batch_settled',
  arguments: [
    { name: 'target_tenant', type: 'STRING', mode: 'IN' }
  ],
  body: `
    UPDATE "tenant_tenant_A_Payment_MS".payments
    SET "status" = 'captured'
    WHERE "tenantId" = target_tenant AND "status" = 'authorized';
  `
});

// 6. Table: invoices (using sequence default)
m16.schemas[0].resources.push({
  type: 'TABLE',
  name: 'invoices',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'invoiceNumber', type: 'BIGINT', default: "nextval('seq_invoice_number')" },
    { name: 'amount', type: 'NUMERIC' },
    { name: 'fee', type: 'NUMERIC' },
    { name: 'status', type: 'STRING', length: 50, default: 'issued' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});

steps.push({ name: '16-sequences-and-custom-functions', manifest: m16 });

// ── Step 17: Recursive CTEs, CHECK Constraints & Triggers ────────────────────
const m17 = clone(m16);

// 1. Table: affiliate_referrals (parent-child affiliate tree)
m17.schemas[0].resources.push({
  type: 'TABLE',
  name: 'affiliate_referrals',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'parentAffiliateId', type: 'UUID' },
    { name: 'affiliateName', type: 'STRING', length: 100 },
    { name: 'tier', type: 'STRING', length: 50, default: 'bronze' },
    { name: 'commissionRate', type: 'NUMERIC', default: '0.05' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});

// 2. Declarative View with RECURSIVE CTE: view_affiliate_hierarchy_tree
m17.schemas[0].resources.push({
  type: 'VIEW',
  name: 'view_affiliate_hierarchy_tree',
  query: {
    with: [
      {
        name: 'referral_tree',
        columns: ['id', 'affiliateName', 'parentAffiliateId', 'level'],
        base: {
          select: ['id', 'affiliateName', 'parentAffiliateId', { expression: '0', alias: 'level' }],
          from: { resource: 'affiliate_referrals' },
          where: [{ column: 'parentAffiliateId', operator: 'IS_NULL' }]
        },
        unionAll: {
          select: ['a.id', 'a.affiliateName', 'a.parentAffiliateId', { expression: 'rt.level + 1', alias: 'level' }],
          from: { resource: 'affiliate_referrals', alias: 'a' },
          joins: [
            { type: 'INNER', resource: 'referral_tree', alias: 'rt', on: { left: 'a.parentAffiliateId', operator: 'EQ', right: 'rt.id' } }
          ]
        }
      }
    ],
    select: ['id', 'affiliateName', 'parentAffiliateId', 'level'],
    from: { resource: 'referral_tree' },
    orderBy: [{ column: 'level', direction: 'ASC' }]
  }
});

// 3. Table with CHECK Constraints: order_discounts
m17.schemas[0].resources.push({
  type: 'TABLE',
  name: 'order_discounts',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'code', type: 'STRING', length: 50 },
    { name: 'discountPercent', type: 'INT' },
    { name: 'amountSaved', type: 'NUMERIC' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
  ],
  constraints: [
    { name: 'chk_discount_pct', type: 'CHECK', expression: 'discountPercent >= 0 AND discountPercent <= 100' },
    { name: 'chk_amount_saved', type: 'CHECK', expression: 'amountSaved >= 0' }
  ]
});

// 4. Table with Functional Trigger: payment_audit_tokens
m17.schemas[0].resources.push({
  type: 'TABLE',
  name: 'payment_audit_tokens',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'tokenHash', type: 'STRING', length: 64, strategy: 'FUNCTIONAL', default: "MD5(tenantId || id::text)" },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});

steps.push({ name: '17-recursive-ctes-and-triggers', manifest: m17 });

// ── Step 18: Table Partitioning, Stored Generated Columns & Indexes ──────────
const m18 = clone(m17);

// 1. Table with Stored Generated Column: invoices_with_tax
m18.schemas[0].resources.push({
  type: 'TABLE',
  name: 'invoices_with_tax',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'subtotal', type: 'NUMERIC' },
    { name: 'taxAmount', type: 'NUMERIC', generated: 'subtotal * 0.18', stored: true },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});

// 2. Partitioned Table: high_volume_audit_partitioned
m18.schemas[0].resources.push({
  type: 'TABLE',
  name: 'high_volume_audit_partitioned',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7' },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'action', type: 'STRING', length: 100 },
    { name: 'payload', type: 'JSONB' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
  ],
  partitionBy: { type: 'RANGE', column: 'createdAt' }
});

// 3. Maintenance tuning on tenants
const tenants18 = m18.schemas[0].resources.find(r => r.name === 'tenants');
tenants18.maintenance = { fillfactor: 85, autovacuum_enabled: true };

steps.push({ name: '18-partitioning-indexes-and-generated-cols', manifest: m18 });

// ── Step 19: Security, Row-Level Security (RLS) & Column Masking ─────────────
const m19 = clone(m18);

// 1. Table with RLS, Policies, Masking, and Grants: sensitive_financial_records
m19.schemas[0].resources.push({
  type: 'TABLE',
  name: 'sensitive_financial_records',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'accountNumber', type: 'STRING', length: 50 },
    { name: 'swiftCode', type: 'STRING', length: 50 },
    { name: 'balance', type: 'NUMERIC' },
    { name: 'isAudited', type: 'BOOLEAN', default: 'false' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
  ],
  security: {
    enable_rls: true,
    policies: [
      { name: 'tenant_financial_policy', roles: ['PUBLIC'], using: "tenantId = 'tenant_pm_1'" }
    ],
    masking: [
      { column: 'accountNumber', roles: ['support'], expression: "'****' || RIGHT(accountNumber, 4)" }
    ],
    grants: [
      { role: 'PUBLIC', privileges: ['SELECT', 'INSERT', 'UPDATE'] }
    ]
  }
});

steps.push({ name: '19-security-rls-and-masking', manifest: m19 });

// ── Step 20: Advanced Query Operations & Analytical AST ─────────────────────
const m20 = clone(m19);

m20.schemas[0].resources.push({
  type: 'TABLE',
  name: 'settlement_batches',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'batchCode', type: 'STRING', length: 100 },
    { name: 'totalAmount', type: 'NUMERIC' },
    { name: 'status', type: 'STRING', length: 50, default: 'pending' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});

steps.push({ name: '20-advanced-query-operations', manifest: m20 });

// ── Step 21: Relationships, M:N Bridge Tables & Extensions ──────────────────
const m21 = clone(m20);
m21.extensions = ['btree_gist', 'citext', 'pgcrypto'];

// 1. Table with CITEXT and Column Comments: tags
m21.schemas[0].resources.push({
  type: 'TABLE',
  name: 'tags',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'name', type: 'CITEXT', unique: true, comment: 'Case-insensitive unique tag name' },
    { name: 'category', type: 'STRING', length: 50, default: 'general' },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});

// 2. Table with Composite Primary Key & Table Comment: tenant_metadata
m21.schemas[0].resources.push({
  type: 'TABLE',
  name: 'tenant_metadata',
  comment: 'Tenant key-value configuration ledger',
  identity: {
    type: 'PRIMARY_KEY',
    columns: ['tenantId', 'metaKey']
  },
  columns: [
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'metaKey', type: 'STRING', length: 100 },
    { name: 'metaValue', type: 'TEXT' },
    { name: 'isEncrypted', type: 'BOOLEAN', default: 'false' },
    { name: 'updatedAt', type: 'TIMESTAMP', default: 'NOW()' }
  ]
});

// 3. Declarative Top-Level Relationships:
// - M:N relationship (invoices <-> tags via invoice_tags_bridge)
// - 1:M relationship (tenants <-> settlement_batches)
m21.relationships = [
  {
    name: 'rel_invoices_tags',
    cardinality: 'M:N',
    bridge: 'invoice_tags_bridge',
    from: { resource: 'invoices', field: 'id' },
    to: { resource: 'tags', field: 'id' }
  },
  {
    name: 'rel_tenants_settlement_batches',
    cardinality: '1:M',
    from: { resource: 'tenants', field: 'id' },
    to: { resource: 'settlement_batches', field: 'tenantId' }
  }
];

steps.push({ name: '21-relationships-and-extensions', manifest: m21 });

// ── Step 22: Exclusion Constraints & Function Parameter Modes ───────────────
const m22 = clone(m21);

// 1. Table with EXCLUDE Constraint (GIST index on int4range): merchant_operating_windows
m22.schemas[0].resources.push({
  type: 'TABLE',
  name: 'merchant_operating_windows',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'slotRange', type: 'INT4RANGE' },
    { name: 'channel', type: 'STRING', length: 50, default: 'card' },
    { name: 'status', type: 'STRING', length: 50, default: 'active' }
  ],
  constraints: [
    {
      name: 'no_overlapping_merchant_slots',
      type: 'EXCLUDE',
      using: 'GIST',
      columns: [
        { name: 'tenantId', operator: '=' },
        { name: 'slotRange', operator: '&&' }
      ]
    }
  ]
});

// 2. Custom Function with explicit parameter mode IN: calculate_tiered_rebate
m22.schemas[0].resources.push({
  type: 'FUNCTION',
  name: 'calculate_tiered_rebate',
  returnType: 'NUMERIC',
  arguments: [
    { name: 'sales_volume', type: 'NUMERIC', mode: 'IN' }
  ],
  body: "IF sales_volume > 100000.00 THEN RETURN sales_volume * 0.05; ELSE RETURN sales_volume * 0.02; END IF;"
});

steps.push({ name: '22-exclusion-constraints-and-param-modes', manifest: m22 });

// ── Step 23: In-Fabric Graph Traversal & Analytics ───────────────────────────
const m23 = clone(m22);

// 1. Table for In-Fabric Recursive Graph BFS Traversal: organization_hierarchy
m23.schemas[0].resources.push({
  type: 'TABLE',
  name: 'organization_hierarchy',
  columns: [
    { name: 'id', type: 'UUID', strategy: 'UUID_V7', primaryKey: true },
    { name: 'tenantId', type: 'STRING', length: 50 },
    { name: 'parentId', type: 'UUID' },
    { name: 'nodeName', type: 'STRING', length: 100 },
    { name: 'department', type: 'STRING', length: 100 },
    { name: 'budget', type: 'NUMERIC' }
  ]
});

steps.push({ name: '23-in-fabric-graph-and-analytics', manifest: m23 });

// ── Step 24: Comprehensive Engine Capabilities & REST Data APIs ─────────────
const m24 = clone(m23);
steps.push({ name: '24-advanced-engine-features', manifest: m24 });

// ── Write out JSON files ────────────────────────────────────────────────────
for (const s of steps) {
  const filePath = path.join(manifestsDir, `${s.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(s.manifest, null, 2), 'utf8');
  console.log(`Generated: ${s.name}.json (${s.manifest.schemas[0].resources.length} resources)`);
}

console.log(`\nSuccessfully generated ${steps.length} manifest files in ${manifestsDir}`);


