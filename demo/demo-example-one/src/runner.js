/**
 * Zero Data Fabric End-to-End Migration & Robustness Test Runner
 */
const fs = require('fs');
const path = require('path');
const DataFabricClient = require('./client');

// ANSI Color Helpers
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m'
};

function logHeader(title) {
  console.log(`\n${colors.bold}${colors.cyan}══════════════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}  ${title}${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}══════════════════════════════════════════════════════════════════════${colors.reset}`);
}

function logStep(stepNum, name) {
  console.log(`\n${colors.bold}${colors.magenta}▶ [Step ${String(stepNum).padStart(2, '0')}] ${name}${colors.reset}`);
}

function logPass(msg, durationMs) {
  const dur = durationMs !== undefined ? ` ${colors.gray}(${durationMs}ms)${colors.reset}` : '';
  console.log(`  ${colors.green}✔ PASS:${colors.reset} ${msg}${dur}`);
}

function logFail(msg, error) {
  console.log(`  ${colors.red}✖ FAIL:${colors.reset} ${msg}`);
  if (error) console.log(`    ${colors.red}${error.message || JSON.stringify(error)}${colors.reset}`);
}

class TestRunner {
  constructor(options = {}) {
    this.client = new DataFabricClient(options);
    this.schema = 'Payment_MS';
    this.manifestsDir = path.join(__dirname, 'manifests');
    this.results = [];
    this.savedIds = {}; // Track IDs across migration steps
  }

  async runAssertion(desc, fn) {
    const start = Date.now();
    try {
      const res = await fn();
      const dur = Date.now() - start;
      logPass(desc, dur);
      this.results.push({ description: desc, passed: true, durationMs: dur });
      return res;
    } catch (err) {
      const dur = Date.now() - start;
      const errMsg = err.response?.data?.error || (err.response?.data ? JSON.stringify(err.response.data) : err.message);
      logFail(desc, { message: errMsg });
      this.results.push({ description: desc, passed: false, durationMs: dur, error: errMsg });
      throw err;
    }
  }

  async executeStep(stepIndex, stepName, mutateAndVerifyFn) {
    logStep(stepIndex, stepName);
    const manifestFile = `${String(stepIndex).padStart(2, '0')}-${stepName}.json`;
    const manifestPath = path.join(this.manifestsDir, manifestFile);
    if (!fs.existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // 1. Diff Validation
    const diff = await this.runAssertion(`Diff manifest: ${manifestFile}`, async () => {
      const d = await this.client.diff(manifest);
      if (!d || typeof d !== 'object') throw new Error('Invalid diff response');
      return d;
    });

    // 2. Apply Migration
    await this.runAssertion(`Apply manifest: ${manifestFile}`, async () => {
      const applyRes = await this.client.apply(manifest, true);
      if (applyRes.status !== 'APPLIED') throw new Error(`Apply status was ${applyRes.status}`);
      return applyRes;
    });

    // 3. Mutate and Verify
    if (mutateAndVerifyFn) {
      await mutateAndVerifyFn(diff);
    }
  }

  async cleanSlate() {
    const { Client } = require('pg');
    const client = new Client({
      connectionString: process.env.DATABASE_URL || 'postgresql://fabric_admin:fabric_password@localhost:5434/datafabric'
    });
    try {
      await client.connect();
      await client.query('DROP SCHEMA IF EXISTS "tenant_tenant_A_Payment_MS" CASCADE');
      await client.query(`
        DELETE FROM public.catalog_tables WHERE schema_id IN (SELECT id FROM public.catalog_schemas WHERE name='Payment_MS');
        DELETE FROM public.catalog_schemas WHERE name='Payment_MS';
      `);
      await client.end();
    } catch (err) {
      console.warn('Clean slate warning:', err.message);
    }
  }

  async runAll() {
    logHeader('ZERO DATA FABRIC: PAYMENT-MS FULL MIGRATION & ROBUSTNESS TEST');
    const overallStart = Date.now();

    await this.runAssertion('Reset test environment (clean slate)', async () => {
      await this.cleanSlate();
      return true;
    });

    await this.runAssertion('Authenticate with Data Fabric Engine', async () => {
      const token = await this.client.authenticate();
      if (!token) throw new Error('Token is missing');
      return token;
    });

    // ── STEP 00: Initial Schema ─────────────────────────────────────────────
    await this.executeStep(0, 'initial-schema', async () => {
      // 1. Insert Tenant
      await this.runAssertion('Insert baseline tenant (tenants)', async () => {
        const res = await this.client.insert(this.schema, 'tenants', {
          id: 'tenant_pm_1',
          name: 'Acme Payments Corp',
          slug: 'acme-payments',
          status: 'active',
          plan: 'pro',
          settings: { mode: 'test', currency: 'INR' },
          billing: { email: 'billing@acme.com' },
          ownerUserId: 'user_owner_001',
          ownerEmail: 'owner@acme.com'
        });
        if (res.rowCount !== 1) throw new Error('Tenant insert failed');
      });

      // 2. Insert Role
      await this.runAssertion('Insert role (roles)', async () => {
        const res = await this.client.insert(this.schema, 'roles', {
          id: 'role_pm_admin',
          tenantId: 'tenant_pm_1',
          name: 'Payment Administrator',
          description: 'Full payment access',
          permissions: ['payments:read', 'payments:write', 'refunds:create']
        });
        if (res.rowCount !== 1) throw new Error('Role insert failed');
      });

      // 3. Insert Provider Config
      await this.runAssertion('Insert provider config (provider_configs)', async () => {
        const res = await this.client.insert(this.schema, 'provider_configs', {
          id: 'pconf_stripe_01',
          tenantId: 'tenant_pm_1',
          provider: 'stripe',
          name: 'Stripe India Primary',
          isEnabled: true,
          isDefault: true,
          mode: 'live',
          credentials: { apiKey: 'sk_live_sample_key_12345' },
          webhookSecret: 'whsec_secret_initial_v1',
          webhookUrl: 'https://acme.com/api/webhooks/stripe'
        });
        if (res.rowCount !== 1) throw new Error('Provider config insert failed');
      });

      // 4. Insert Payment
      await this.runAssertion('Insert payment record (payments)', async () => {
        const res = await this.client.insert(this.schema, 'payments', {
          tenantId: 'tenant_pm_1',
          orderId: 'ORD_2026_001',
          amount: 14999.50,
          currency: 'INR',
          status: 'captured',
          provider: 'stripe',
          providerPaymentId: 'ch_stripe_pay_998877',
          providerOrderId: 'pi_stripe_order_112233',
          providerConfigId: 'pconf_stripe_01',
          customerId: 'cust_001',
          customerEmail: 'alex@example.com',
          customerPhone: '+919876543210',
          paymentMethod: 'card',
          paymentMethodDetails: { brand: 'visa', last4: '4242' },
          description: 'Cloud subscription annual'
        });
        if (!res.returning?.[0]?.id) throw new Error('Payment insert did not return UUID id');
        this.savedIds.paymentId = res.returning[0].id;
      });

      // 5. Insert Refund
      await this.runAssertion('Insert refund record (refunds)', async () => {
        const res = await this.client.insert(this.schema, 'refunds', {
          tenantId: 'tenant_pm_1',
          paymentId: this.savedIds.paymentId,
          refundId: 'REF_2026_001',
          amount: 2500.00,
          currency: 'INR',
          status: 'completed',
          reason: 'customer_request',
          providerRefundId: 're_stripe_ref_445566',
          notes: 'Partial goodwill refund'
        });
        if (!res.returning?.[0]?.id) throw new Error('Refund insert failed');
        this.savedIds.refundId = res.returning[0].id;
      });

      // 6. Insert Webhook
      await this.runAssertion('Insert webhook configuration (webhooks)', async () => {
        const res = await this.client.insert(this.schema, 'webhooks', {
          tenantId: 'tenant_pm_1',
          url: 'https://acme.com/api/payment-events',
          secret: 'whsec_test_secret_initial',
          events: ['payment.captured', 'refund.completed'],
          status: 'active',
          description: 'Production events webhook'
        });
        if (!res.returning?.[0]?.id) throw new Error('Webhook insert failed');
        this.savedIds.webhookId = res.returning[0].id;
      });

      // 7. Update Baseline Records (tenants & payments)
      await this.runAssertion('Update baseline tenant name and settings (tenants)', async () => {
        const res = await this.client.update(
          this.schema,
          'tenants',
          { name: 'Acme Global Payments Corp', settings: { mode: 'test', currency: 'INR', tier: 'tier_1' } },
          { id: { $eq: 'tenant_pm_1' } }
        );
        if (res.rowCount !== 1) throw new Error('Tenant update failed');
      });

      await this.runAssertion('Update baseline payment description (payments)', async () => {
        const res = await this.client.update(
          this.schema,
          'payments',
          { description: 'Cloud subscription annual - updated description' },
          { id: { $eq: this.savedIds.paymentId } }
        );
        if (res.rowCount !== 1) throw new Error('Payment description update failed');
      });

      // 8. Verify Queries
      await this.runAssertion('SELECT payments with WHERE filter and LIMIT', async () => {
        const res = await this.client.select(this.schema, 'payments', {
          limit: 10,
          where: [{ column: 'orderId', operator: 'EQ', value: 'ORD_2026_001' }]
        });
        if (res.data?.length !== 1) throw new Error(`Expected 1 payment, found ${res.data?.length}`);
        if (res.data[0].amount != 14999.50) throw new Error(`Amount mismatch: ${res.data[0].amount}`);
      });

      // 9. Test Relational JOIN
      await this.runAssertion('AST JOIN between tenants and payments', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 10,
          query: {
            select: ['tenants.name', 'tenants.slug', 'payments.orderId', 'payments.amount', 'payments.status'],
            from: { resource: 'tenants' },
            joins: [
              {
                type: 'INNER',
                resource: 'payments',
                on: { left: 'tenants.id', operator: 'EQ', right: 'payments.tenantId' }
              }
            ],
            where: [{ column: 'tenants.id', operator: 'EQ', value: 'tenant_pm_1' }]
          }
        });
        if (res.data?.length !== 1) throw new Error(`Expected 1 joined row, found ${res.data?.length}`);
        if (res.data[0].name !== 'Acme Global Payments Corp') throw new Error('Joined tenant name mismatch');
      });
    });

    // ── STEP 01: Checkout Token & Provider Channel ──────────────────────────
    await this.executeStep(1, 'checkout-token', async () => {
      // 1. UPDATE: Update existing payment with new checkoutToken
      await this.runAssertion('Update payment with new checkoutToken', async () => {
        const res = await this.client.update(
          this.schema,
          'payments',
          { checkoutToken: 'chk_tok_unique_111222' },
          { id: { $eq: this.savedIds.paymentId } }
        );
        if (res.rowCount !== 1) throw new Error('Payment checkoutToken update failed');
      });

      // 2. UPDATE: Update existing provider_config with new channel column
      await this.runAssertion('Update provider_config with new channel column', async () => {
        const res = await this.client.update(
          this.schema,
          'provider_configs',
          { channel: 'ecommerce_web' },
          { id: { $eq: 'pconf_stripe_01' } }
        );
        if (res.rowCount !== 1) throw new Error('Provider channel update failed');
      });

      // 3. INSERT: Insert fresh payment directly supplying checkoutToken
      await this.runAssertion('Insert new payment with checkoutToken column populated', async () => {
        const res = await this.client.insert(this.schema, 'payments', {
          tenantId: 'tenant_pm_1',
          orderId: 'ORD_2026_002',
          amount: 5499.00,
          currency: 'INR',
          status: 'pending',
          provider: 'stripe',
          checkoutToken: 'chk_tok_fresh_step01'
        });
        if (!res.returning?.[0]?.id) throw new Error('Payment insert with checkoutToken failed');
        this.savedIds.step01PaymentId = res.returning[0].id;
      });

      await this.runAssertion('SELECT payment by newly added checkoutToken', async () => {
        const res = await this.client.select(this.schema, 'payments', {
          limit: 5,
          where: [{ column: 'checkoutToken', operator: 'EQ', value: 'chk_tok_unique_111222' }]
        });
        if (res.data?.length !== 1) throw new Error('Failed to find payment by checkoutToken');
      });
    });

    // ── STEP 02: Disputes, Capture & Webhook Durability ─────────────────────
    await this.executeStep(2, 'disputes-and-capture', async () => {
      // 1. INSERT: Insert into newly created disputes table
      await this.runAssertion('Insert record into newly created disputes table', async () => {
        const res = await this.client.insert(this.schema, 'disputes', {
          tenantId: 'tenant_pm_1',
          paymentId: this.savedIds.paymentId,
          disputeId: 'DISP_2026_001',
          amount: 3000.00,
          currency: 'INR',
          status: 'needs_response',
          reason: 'unrecognized_transaction',
          evidence: { customerNote: 'Customer did not recognize descriptor' }
        });
        if (!res.returning?.[0]?.id) throw new Error('Dispute insert failed');
        this.savedIds.disputeId = res.returning[0].id;
      });

      // 2. INSERT: Insert new payment with autoCapture columns already populated
      await this.runAssertion('Insert new payment with autoCapture columns populated', async () => {
        const res = await this.client.insert(this.schema, 'payments', {
          tenantId: 'tenant_pm_1',
          orderId: 'ORD_2026_003',
          amount: 8999.00,
          currency: 'INR',
          status: 'captured',
          provider: 'stripe',
          autoCapture: true,
          capturedAmount: 8999.00,
          authorizedAmount: 8999.00,
          providerFee: 180.00
        });
        if (!res.returning?.[0]?.id) throw new Error('Payment insert with capture failed');
      });

      // 3. UPDATE: Update baseline payment with capture columns
      await this.runAssertion('Update payment with capture columns', async () => {
        const res = await this.client.update(
          this.schema,
          'payments',
          {
            autoCapture: true,
            capturedAmount: 14999.50,
            authorizedAmount: 14999.50,
            providerFee: 299.99,
            capturedBy: 'system_auto'
          },
          { id: { $eq: this.savedIds.paymentId } }
        );
        if (res.rowCount !== 1) throw new Error('Payment capture update failed');
      });

      // 4. UPDATE: Update disputes record status
      await this.runAssertion('Update dispute record status to under_review', async () => {
        const res = await this.client.update(
          this.schema,
          'disputes',
          { status: 'under_review' },
          { id: { $eq: this.savedIds.disputeId } }
        );
        if (res.rowCount !== 1) throw new Error('Dispute status update failed');
      });

      // 5. UPDATE: Update webhook with durability metrics
      await this.runAssertion('Update webhook with durability metrics', async () => {
        const res = await this.client.update(
          this.schema,
          'webhooks',
          {
            failureCount: 0,
            lastSuccessAt: new Date().toISOString()
          },
          { id: { $eq: this.savedIds.webhookId } }
        );
        if (res.rowCount !== 1) throw new Error('Webhook durability update failed');
      });

      await this.runAssertion('JOIN query across payments and disputes', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 10,
          query: {
            select: ['payments.orderId', 'disputes.disputeId', 'disputes.amount', 'disputes.status'],
            from: { resource: 'payments' },
            joins: [
              {
                type: 'INNER',
                resource: 'disputes',
                on: { left: 'payments.id', operator: 'EQ', right: 'disputes.paymentId' }
              }
            ]
          }
        });
        if (res.data?.length !== 1) throw new Error(`Expected 1 dispute join, found ${res.data?.length}`);
      });
    });

    // ── STEP 03: Tenant Pending Verification ────────────────────────────────
    await this.executeStep(3, 'tenant-pending-verification', async () => {
      await this.runAssertion('Insert tenant using new enum value: pending_verification', async () => {
        const res = await this.client.insert(this.schema, 'tenants', {
          id: 'tenant_pm_unverified',
          name: 'Unverified Merchant Ltd',
          slug: 'unverified-merchant',
          status: 'pending_verification',
          plan: 'free',
          settings: { verificationToken: 'vtok_abc_987' }
        });
        if (res.rowCount !== 1) throw new Error('Unverified tenant insert failed');
      });

      await this.runAssertion('Update unverified tenant to active', async () => {
        const res = await this.client.update(
          this.schema,
          'tenants',
          { status: 'active' },
          { id: { $eq: 'tenant_pm_unverified' } }
        );
        if (res.rowCount !== 1) throw new Error('Tenant status update to active failed');
      });
    });

    // ── STEP 04: Customer Identity & Refund Rules ───────────────────────────
    await this.executeStep(4, 'customer-identity-refund-rules', async () => {
      // 1. INSERT: Insert into newly created customers table
      await this.runAssertion('Insert into newly created customers table', async () => {
        const res = await this.client.insert(this.schema, 'customers', {
          tenantId: 'tenant_pm_1',
          customerId: 'cust_verified_001',
          email: 'alex.verified@example.com',
          phone: '+919988776655',
          name: 'Alexander Hamilton',
          metadata: { kycStatus: 'VERIFIED', tier: 'GOLD' }
        });
        if (!res.returning?.[0]?.id) throw new Error('Customer insert failed');
        this.savedIds.customerId = res.returning[0].id;
      });

      // 2. INSERT: Insert into newly created refund_rules table
      await this.runAssertion('Insert into newly created refund_rules table', async () => {
        const res = await this.client.insert(this.schema, 'refund_rules', {
          tenantId: 'tenant_pm_1',
          name: 'Restocking Fee Rule',
          description: 'Deduct 5% restocking fee on physical goods',
          isActive: true,
          priority: 10,
          ruleType: 'restocking_fee',
          deductionType: 'percentage',
          deductionValue: 5.00,
          conditions: { category: 'electronics' }
        });
        if (!res.returning?.[0]?.id) throw new Error('Refund rule insert failed');
      });

      // 3. UPDATE: Update customer phone and metadata
      await this.runAssertion('Update customer phone and metadata', async () => {
        const res = await this.client.update(
          this.schema,
          'customers',
          {
            phone: '+919988770000',
            metadata: { kycStatus: 'VERIFIED', tier: 'PLATINUM' }
          },
          { id: { $eq: this.savedIds.customerId } }
        );
        if (res.rowCount !== 1) throw new Error('Customer update failed');
      });

      // 4. UPDATE: Update refund_rules deductionValue
      await this.runAssertion('Update refund_rules deductionValue', async () => {
        const res = await this.client.update(
          this.schema,
          'refund_rules',
          { deductionValue: 7.50 },
          { name: { $eq: 'Restocking Fee Rule' } }
        );
        if (res.rowCount !== 1) throw new Error('Refund rule update failed');
      });

      await this.runAssertion('Query customers by email with WHERE filter', async () => {
        const res = await this.client.select(this.schema, 'customers', {
          limit: 5,
          where: [{ column: 'email', operator: 'EQ', value: 'alex.verified@example.com' }]
        });
        if (res.data?.length !== 1) throw new Error('Customer query failed');
      });
    });

    // ── STEP 05: Production Hardening ───────────────────────────────────────
    await this.executeStep(5, 'production-hardening', async () => {
      // 1. UPDATE: Test type widening on webhooks.secret (> 255 chars)
      await this.runAssertion('Test type widening: update webhooks.secret (> 255 chars)', async () => {
        const longSecret = 'enc:v1:' + 'A'.repeat(320); // 327 chars
        const res = await this.client.update(
          this.schema,
          'webhooks',
          { secret: longSecret },
          { id: { $eq: this.savedIds.webhookId } }
        );
        if (res.rowCount !== 1) throw new Error('Widened webhook secret update failed');
      });

      // 2. INSERT: Insert IPv6 entry into newly created ip_block_entries
      await this.runAssertion('Insert IPv6 entry in ip_block_entries', async () => {
        const res = await this.client.insert(this.schema, 'ip_block_entries', {
          tenantId: 'tenant_pm_1',
          ipOrCidr: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
          reason: 'Excessive bot card testing',
          blockedBy: 'fraud_shield_auto'
        });
        if (!res.returning?.[0]?.id) throw new Error('IPv6 entry insert failed');
      });

      // 3. INSERT: Insert into newly created payment_links table
      await this.runAssertion('Insert into newly created payment_links table', async () => {
        const res = await this.client.insert(this.schema, 'payment_links', {
          tenantId: 'tenant_pm_1',
          title: 'Consulting Invoice #99',
          description: 'Payment for security review',
          amount: 50000.00,
          currency: 'INR',
          status: 'active',
          shortCode: 'pl_security_rev_99',
          maxUses: 1,
          currentUses: 0
        });
        if (!res.returning?.[0]?.id) throw new Error('Payment link insert failed');
        this.savedIds.paymentLinkId = res.returning[0].id;
      });

      // 4. UPDATE: Update payment with fraud and link columns
      await this.runAssertion('Update payment with fraud and link columns', async () => {
        const res = await this.client.update(
          this.schema,
          'payments',
          {
            customerIp: '49.207.180.12',
            paymentLinkId: this.savedIds.paymentLinkId,
            manualReviewStatus: 'APPROVED',
            manualReviewNotes: 'Verified via 3D Secure v2 OTP',
            manualReviewedBy: 'compliance_officer_1'
          },
          { id: { $eq: this.savedIds.paymentId } }
        );
        if (res.rowCount !== 1) throw new Error('Payment fraud columns update failed');
      });

      // 5. UPDATE: Update payment_links title and amount
      await this.runAssertion('Update payment_links title and amount', async () => {
        const res = await this.client.update(
          this.schema,
          'payment_links',
          {
            title: 'Consulting Invoice #99 (Revised)',
            amount: 52000.00
          },
          { id: { $eq: this.savedIds.paymentLinkId } }
        );
        if (res.rowCount !== 1) throw new Error('Payment link update failed');
      });
    });

    // ── STEP 06: Payment Method Selection ───────────────────────────────────
    await this.executeStep(6, 'payment-method-selection', async () => {
      // 1. UPDATE: Update existing payment_links with allowedMethods and enforceMethods
      await this.runAssertion('Update payment_links with allowedMethods and enforceMethods', async () => {
        const res = await this.client.update(
          this.schema,
          'payment_links',
          {
            allowedMethods: ['upi', 'card'],
            enforceMethods: true
          },
          { id: { $eq: this.savedIds.paymentLinkId } }
        );
        if (res.rowCount !== 1) throw new Error('Payment link method restrictions update failed');
      });

      // 2. INSERT: Insert fresh payment_link directly specifying allowedMethods & enforceMethods
      await this.runAssertion('Insert new payment_link specifying allowedMethods and enforceMethods', async () => {
        const res = await this.client.insert(this.schema, 'payment_links', {
          tenantId: 'tenant_pm_1',
          title: 'Express Checkout Link',
          amount: 1200.00,
          currency: 'INR',
          status: 'active',
          shortCode: 'pl_express_step06',
          allowedMethods: ['upi', 'netbanking'],
          enforceMethods: true
        });
        if (!res.returning?.[0]?.id) throw new Error('Payment link insert with allowedMethods failed');
      });

      await this.runAssertion('SELECT payment link and verify allowedMethods JSON', async () => {
        const res = await this.client.select(this.schema, 'payment_links', {
          limit: 5,
          where: [{ column: 'shortCode', operator: 'EQ', value: 'pl_security_rev_99' }]
        });
        if (res.data?.[0]?.enforceMethods !== true) throw new Error('enforceMethods was not true');
      });
    });

    // ── STEP 07: Provider Soft Delete ───────────────────────────────────────
    await this.executeStep(7, 'provider-soft-delete', async () => {
      await this.runAssertion('Insert secondary provider to soft delete', async () => {
        await this.client.insert(this.schema, 'provider_configs', {
          id: 'pconf_retiring_02',
          tenantId: 'tenant_pm_1',
          provider: 'razorpay',
          name: 'Razorpay Deprecated Gate',
          isEnabled: false
        });
      });

      await this.runAssertion('Perform soft delete by setting deletedAt timestamp', async () => {
        const res = await this.client.update(
          this.schema,
          'provider_configs',
          { deletedAt: new Date().toISOString() },
          { id: { $eq: 'pconf_retiring_02' } }
        );
        if (res.rowCount !== 1) throw new Error('Provider soft delete failed');
      });

      await this.runAssertion('Query live vs soft-deleted providers', async () => {
        const liveRes = await this.client.select(this.schema, 'provider_configs', {
          limit: 10,
          where: [{ column: 'deletedAt', operator: 'IS_NULL', value: null }]
        });
        const hasLive = liveRes.data?.some(p => p.id === 'pconf_stripe_01');
        if (!hasLive) throw new Error('Active provider not found in live query');
      });
    });

    // ── STEP 08: Money Hardening ────────────────────────────────────────────
    await this.executeStep(8, 'money-hardening', async () => {
      // 1. UPDATE: Update existing payment with requestHash
      await this.runAssertion('Update payment with requestHash', async () => {
        const hash = 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef'; // 64 chars
        const res = await this.client.update(
          this.schema,
          'payments',
          { requestHash: hash },
          { id: { $eq: this.savedIds.paymentId } }
        );
        if (res.rowCount !== 1) throw new Error('Payment requestHash update failed');
      });

      // 2. UPDATE: Update existing refund with idempotencyKey and requestHash
      await this.runAssertion('Update refund with idempotencyKey and requestHash', async () => {
        const res = await this.client.update(
          this.schema,
          'refunds',
          {
            idempotencyKey: 'idem_ref_key_998877665544',
            requestHash: 'f0e1d2c3b4a567890123456789abcdef0123456789abcdef0123456789abcdef' // 64 chars
          },
          { id: { $eq: this.savedIds.refundId } }
        );
        if (res.rowCount !== 1) throw new Error('Refund idempotency update failed');
      });

      // 3. INSERT: Insert fresh payment directly specifying requestHash
      await this.runAssertion('Insert payment specifying requestHash upon creation', async () => {
        const hash = 'b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef01'; // 64 chars
        const res = await this.client.insert(this.schema, 'payments', {
          tenantId: 'tenant_pm_1',
          orderId: 'ORD_2026_004',
          amount: 2500.00,
          currency: 'INR',
          status: 'captured',
          provider: 'stripe',
          requestHash: hash
        });
        if (!res.returning?.[0]?.id) throw new Error('Payment insert with requestHash failed');
      });

      // 4. INSERT: Insert fresh refund directly specifying idempotencyKey and requestHash
      await this.runAssertion('Insert refund specifying idempotencyKey and requestHash upon creation', async () => {
        const res = await this.client.insert(this.schema, 'refunds', {
          tenantId: 'tenant_pm_1',
          paymentId: this.savedIds.paymentId,
          refundId: 'REF_2026_002',
          amount: 500.00,
          currency: 'INR',
          status: 'completed',
          reason: 'customer_request',
          idempotencyKey: 'idem_key_direct_insert_8877',
          requestHash: 'c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef012' // 64 chars
        });
        if (!res.returning?.[0]?.id) throw new Error('Refund insert with idempotencyKey failed');
      });
    });

    // ── STEP 09: Provider Callback Forwarding ───────────────────────────────
    await this.executeStep(9, 'provider-callback-forwarding', async () => {
      // 1. UPDATE: Link existing webhook to specific provider config via providerConfigId
      await this.runAssertion('Link webhook to specific provider config via providerConfigId', async () => {
        const res = await this.client.update(
          this.schema,
          'webhooks',
          { providerConfigId: 'pconf_stripe_01' },
          { id: { $eq: this.savedIds.webhookId } }
        );
        if (res.rowCount !== 1) throw new Error('Webhook providerConfigId update failed');
      });

      // 2. INSERT: Insert new webhook configuration linked directly to providerConfigId
      await this.runAssertion('Insert new webhook configuration linked to providerConfigId', async () => {
        const res = await this.client.insert(this.schema, 'webhooks', {
          tenantId: 'tenant_pm_1',
          url: 'https://acme.com/api/stripe-direct-events',
          secret: 'whsec_stripe_direct_secret_09',
          events: ['payment.failed', 'dispute.created'],
          status: 'active',
          providerConfigId: 'pconf_stripe_01',
          description: 'Provider-specific forwarding webhook'
        });
        if (!res.returning?.[0]?.id) throw new Error('Webhook insert with providerConfigId failed');
      });

      await this.runAssertion('JOIN webhooks and provider_configs', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 10,
          query: {
            select: ['webhooks.url', 'provider_configs.provider', 'provider_configs.name'],
            from: { resource: 'webhooks' },
            joins: [
              {
                type: 'INNER',
                resource: 'provider_configs',
                on: { left: 'webhooks.providerConfigId', operator: 'EQ', right: 'provider_configs.id' }
              }
            ]
          }
        });
        if (res.data?.length < 1) throw new Error('Webhook provider join failed');
      });
    });

    // ── STEP 10: Plans & Trials ─────────────────────────────────────────────
    await this.executeStep(10, 'plans-and-trials', async () => {
      // 1. INSERT: Insert into newly created plans table
      await this.runAssertion('Insert into newly created plans table', async () => {
        const res = await this.client.insert(this.schema, 'plans', {
          id: 'custom_enterprise_2026',
          name: 'Custom Enterprise Tier',
          description: 'Unlimited volume with dedicated TAM',
          limits: { maxConnections: 100, maxQueriesPerSec: 5000 },
          trialDays: 14,
          status: 'active'
        });
        if (res.rowCount !== 1) throw new Error('Plan insert failed');
      });

      // 2. INSERT: Insert into newly created plan_requests table
      await this.runAssertion('Insert into newly created plan_requests table', async () => {
        const res = await this.client.insert(this.schema, 'plan_requests', {
          tenantId: 'tenant_pm_1',
          planId: 'custom_enterprise_2026',
          status: 'pending',
          contactEmail: 'cto@acme.com',
          message: 'Interested in annual multi-region license.'
        });
        if (!res.returning?.[0]?.id) throw new Error('Plan request insert failed');
      });

      // 3. INSERT: Insert new tenant directly with custom non-enum varchar plan
      await this.runAssertion('Insert new tenant with custom non-enum plan directly', async () => {
        const res = await this.client.insert(this.schema, 'tenants', {
          id: 'tenant_pm_direct_custom',
          name: 'Direct Custom Plan Merchant',
          slug: 'direct-custom-merchant',
          status: 'active',
          plan: 'custom_enterprise_2026', // non-enum varchar plan
          settings: { direct: true }
        });
        if (res.rowCount !== 1) throw new Error('Tenant with custom plan insert failed');
      });

      // 4. UPDATE: Update plan_requests status to approved
      await this.runAssertion('Update plan_requests status to approved', async () => {
        const res = await this.client.update(
          this.schema,
          'plan_requests',
          { status: 'approved' },
          { tenantId: { $eq: 'tenant_pm_1' } }
        );
        if (res.rowCount !== 1) throw new Error('Plan request status update failed');
      });

      // 5. UPDATE: Data Type Change Validation - tenants.plan was ENUM, now VARCHAR(50)
      await this.runAssertion('Data type change: update tenants.plan to non-enum string', async () => {
        const res = await this.client.update(
          this.schema,
          'tenants',
          {
            plan: 'custom_enterprise_2026', // String not in old enum!
            planStartedAt: new Date().toISOString(),
            planExpiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
            trialUsedAt: new Date().toISOString()
          },
          { id: { $eq: 'tenant_pm_1' } }
        );
        if (res.rowCount !== 1) throw new Error('Plan varchar update failed');
      });

      await this.runAssertion('Verify tenant plan was updated to custom string', async () => {
        const res = await this.client.select(this.schema, 'tenants', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: 'tenant_pm_1' }]
        });
        if (res.data?.[0]?.plan !== 'custom_enterprise_2026') {
          throw new Error(`Expected plan custom_enterprise_2026, got ${res.data?.[0]?.plan}`);
        }
      });
    });

    // ── STEP 11: Hide Legacy Plans ──────────────────────────────────────────
    await this.executeStep(11, 'hide-legacy-plans', async () => {
      // 1. INSERT: Insert legacy plan templates
      await this.runAssertion('Insert legacy plan templates', async () => {
        for (const planKey of ['legacy_free', 'legacy_starter']) {
          await this.client.insert(this.schema, 'plans', {
            id: planKey,
            name: `Legacy ${planKey}`,
            description: 'Legacy pricing tier',
            status: 'active'
          });
        }
      });

      // 2. UPDATE: Data migration - update legacy plans to hidden
      await this.runAssertion('Data migration: update legacy plans to hidden', async () => {
        const res = await this.client.update(
          this.schema,
          'plans',
          { status: 'hidden' },
          { id: { $eq: 'legacy_free' } }
        );
        if (res.rowCount !== 1) throw new Error('Legacy plan status update failed');
      });

      await this.runAssertion('Verify active vs hidden plans', async () => {
        const hiddenRes = await this.client.select(this.schema, 'plans', {
          limit: 10,
          where: [{ column: 'status', operator: 'EQ', value: 'hidden' }]
        });
        if (!hiddenRes.data?.some(p => p.id === 'legacy_free')) {
          throw new Error('legacy_free plan not found in hidden status query');
        }
      });
    });

    // ── STEP 12: Background Jobs ────────────────────────────────────────────
    await this.executeStep(12, 'background-jobs', async () => {
      // 1. INSERT: Insert into newly created background_jobs table
      await this.runAssertion('Insert into newly created background_jobs table', async () => {
        const res = await this.client.insert(this.schema, 'background_jobs', {
          id: 'job_nightly_reconciliation',
          schedule: '0 2 * * *',
          batchSize: 500,
          concurrency: 4,
          timeoutMs: 180000,
          rateLimitQuota: '2500',   // STRING holding numeric value for future conversion
          autoRetry: 'true',        // STRING holding boolean value for future conversion
          isEnabled: true
        });
        if (res.rowCount !== 1) throw new Error('Background job insert failed');
      });

      // 2. INSERT: Insert into newly created background_job_runs table
      await this.runAssertion('Insert into newly created background_job_runs table', async () => {
        const res = await this.client.insert(this.schema, 'background_job_runs', {
          jobId: 'job_nightly_reconciliation',
          status: 'SUCCESS',
          startedAt: new Date(Date.now() - 60000).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 42150,
          itemsProcessed: 1240,
          retryCountString: '3',   // STRING holding integer value for future conversion
          metadata: { settledAmount: 18450000.00 }
        });
        if (!res.returning?.[0]?.id) throw new Error('Background job run insert failed');
      });

      // 3. INSERT: Insert into newly created job_queue_items table
      await this.runAssertion('Insert into newly created job_queue_items table', async () => {
        const res = await this.client.insert(this.schema, 'job_queue_items', {
          tenantId: 'tenant_pm_1',
          jobType: 'send_settlement_webhook',
          payload: { batchId: 'bat_2026_10_26', totalTx: 1240 },
          status: 'pending',
          attempt: 0,
          maxAttempts: 5,
          priorityScore: '950.50'   // STRING holding decimal numeric value for future conversion
        });
        if (!res.returning?.[0]?.id) throw new Error('Job queue item insert failed');
      });

      // 4. UPDATE: Update background_jobs concurrency and lastRunAt
      await this.runAssertion('Update background_jobs concurrency and lastRunAt', async () => {
        const res = await this.client.update(
          this.schema,
          'background_jobs',
          {
            concurrency: 8,
            lastRunAt: new Date().toISOString()
          },
          { id: { $eq: 'job_nightly_reconciliation' } }
        );
        if (res.rowCount !== 1) throw new Error('Background job update failed');
      });

      // 5. UPDATE: Update job_queue_items status to completed
      await this.runAssertion('Update job_queue_items status to completed', async () => {
        const res = await this.client.update(
          this.schema,
          'job_queue_items',
          {
            status: 'completed',
            completedAt: new Date().toISOString()
          },
          { jobType: { $eq: 'send_settlement_webhook' } }
        );
        if (res.rowCount !== 1) throw new Error('Job queue item update failed');
      });

      await this.runAssertion('JOIN query between background_jobs and runs', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 10,
          query: {
            select: ['background_jobs.id', 'background_jobs.schedule', 'background_job_runs.status', 'background_job_runs.itemsProcessed'],
            from: { resource: 'background_jobs' },
            joins: [
              {
                type: 'INNER',
                resource: 'background_job_runs',
                on: { left: 'background_jobs.id', operator: 'EQ', right: 'background_job_runs.jobId' }
              }
            ]
          }
        });
        if (res.data?.length !== 1) throw new Error('Background job join query failed');
      });
    });

    // ── STEP 13: Type Transformations ──────────────────────────────────────
    await this.executeStep(13, 'type-transformations', async (stepDiff) => {
      // 1. Verify Diff Engine detected ALTER_COLUMN_TYPE actions
      await this.runAssertion('Verify diff detected ALTER_COLUMN_TYPE migrations', async () => {
        const alters = stepDiff.diffs?.filter(d => d.action === 'ALTER_COLUMN_TYPE') || [];
        if (alters.length < 5) throw new Error(`Expected at least 5 ALTER_COLUMN_TYPE diffs, got ${alters.length}`);
      });

      // 2. Verify Converted Existing Records:
      // a. Number to String: background_jobs.batchSize is now string '500'
      await this.runAssertion('Verify Number -> String: background_jobs.batchSize converted to string', async () => {
        const res = await this.client.select(this.schema, 'background_jobs', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: 'job_nightly_reconciliation' }]
        });
        const job = res.data?.[0];
        if (job.batchSize !== '500') throw new Error(`Expected batchSize string '500', got ${JSON.stringify(job.batchSize)}`);
      });

      // b. String to Number: background_jobs.rateLimitQuota is now integer 2500
      await this.runAssertion('Verify String -> Number (INT): rateLimitQuota converted to integer 2500', async () => {
        const res = await this.client.select(this.schema, 'background_jobs', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: 'job_nightly_reconciliation' }]
        });
        const job = res.data?.[0];
        if (job.rateLimitQuota !== 2500) throw new Error(`Expected rateLimitQuota integer 2500, got ${JSON.stringify(job.rateLimitQuota)}`);
      });

      // c. String to Boolean: background_jobs.autoRetry is now boolean true
      await this.runAssertion('Verify String -> Boolean: autoRetry converted to boolean true', async () => {
        const res = await this.client.select(this.schema, 'background_jobs', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: 'job_nightly_reconciliation' }]
        });
        const job = res.data?.[0];
        if (job.autoRetry !== true) throw new Error(`Expected autoRetry boolean true, got ${JSON.stringify(job.autoRetry)}`);
      });

      // d. Boolean to String: background_jobs.isEnabled is now string 'true'
      await this.runAssertion('Verify Boolean -> String: isEnabled converted to string true', async () => {
        const res = await this.client.select(this.schema, 'background_jobs', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: 'job_nightly_reconciliation' }]
        });
        const job = res.data?.[0];
        if (job.isEnabled !== 'true') throw new Error(`Expected isEnabled string 'true', got ${JSON.stringify(job.isEnabled)}`);
      });

      // e. String to Number: background_job_runs.retryCountString is now integer 3
      await this.runAssertion('Verify String -> Number (INT): retryCountString converted to integer 3', async () => {
        const res = await this.client.select(this.schema, 'background_job_runs', {
          limit: 5,
          where: [{ column: 'jobId', operator: 'EQ', value: 'job_nightly_reconciliation' }]
        });
        const run = res.data?.[0];
        if (run.retryCountString !== 3) throw new Error(`Expected retryCountString 3, got ${JSON.stringify(run.retryCountString)}`);
      });

      // f. String to Number (NUMERIC): job_queue_items.priorityScore is now numeric 950.50
      await this.runAssertion('Verify String -> Number (NUMERIC): priorityScore converted to numeric 950.50', async () => {
        const res = await this.client.select(this.schema, 'job_queue_items', {
          limit: 5,
          where: [{ column: 'jobType', operator: 'EQ', value: 'send_settlement_webhook' }]
        });
        const item = res.data?.[0];
        if (parseFloat(item.priorityScore) !== 950.50) throw new Error(`Expected priorityScore 950.50, got ${JSON.stringify(item.priorityScore)}`);
      });

      // g. Number to String: refund_rules.priority is now string '10'
      await this.runAssertion('Verify Number -> String: refund_rules.priority converted to string', async () => {
        const res = await this.client.select(this.schema, 'refund_rules', {
          limit: 5,
          where: [{ column: 'name', operator: 'EQ', value: 'Restocking Fee Rule' }]
        });
        const rule = res.data?.[0];
        if (rule.priority !== '10') throw new Error(`Expected priority string '10', got ${JSON.stringify(rule.priority)}`);
      });

      // 3. INSERT with newly transformed types
      await this.runAssertion('INSERT new background_job using new types directly', async () => {
        const res = await this.client.insert(this.schema, 'background_jobs', {
          id: 'job_hourly_metric_agg',
          schedule: '0 * * * *',
          batchSize: '250',        // string
          timeoutMs: '120000',     // string
          rateLimitQuota: 10000,   // integer
          autoRetry: false,        // boolean
          isEnabled: 'false'       // string
        });
        if (res.rowCount !== 1) throw new Error('Insert with new types failed');
      });

      // 4. UPDATE with newly transformed types
      await this.runAssertion('UPDATE background_job using new types', async () => {
        const res = await this.client.update(
          this.schema,
          'background_jobs',
          {
            rateLimitQuota: 5000,    // integer update
            batchSize: '750',        // string update
            autoRetry: true          // boolean update
          },
          { id: { $eq: 'job_nightly_reconciliation' } }
        );
        if (res.rowCount !== 1) throw new Error('Update with new types failed');
      });

      // 5. Query with numeric operator on newly converted column
      await this.runAssertion('SELECT query with numeric range comparison on rateLimitQuota (GT 4000)', async () => {
        const res = await this.client.select(this.schema, 'background_jobs', {
          limit: 10,
          where: [{ column: 'rateLimitQuota', operator: 'GT', value: 4000 }]
        });
        if (res.data?.length !== 2) throw new Error(`Expected 2 jobs with quota > 4000, got ${res.data?.length}`);
      });

      // 6. Robustness: Check how engine handles invalid/incompatible type conversions via API
      await this.runAssertion('Robustness check: invalid string-to-number conversion rejection via API', async () => {
        const manifest13 = JSON.parse(fs.readFileSync(path.join(this.manifestsDir, '13-type-transformations.json'), 'utf8'));
        const invalidManifest = JSON.parse(JSON.stringify(manifest13));
        const bgJobs = invalidManifest.schemas[0].resources.find(r => r.name === 'background_jobs');
        const schedCol = bgJobs.columns.find(c => c.name === 'schedule');
        schedCol.type = 'INTEGER';
        delete schedCol.length;

        let caughtError = null;
        try {
          await this.client.apply(invalidManifest, true);
        } catch (err) {
          caughtError = err;
        }
        if (!caughtError) throw new Error('Expected Data Fabric API to reject incompatible string-to-int conversion');
      });

      // 7. INSERT edge cases baseline records into edge_case_records
      await this.runAssertion('Insert NULL edge case record into edge_case_records', async () => {
        const res = await this.client.insert(this.schema, 'edge_case_records', {
          tenantId: 'tenant_pm_1',
          nullStrToInt: null,
          nullNumToStr: null,
          nullBoolToStr: null,
          nullTsToDate: null,
          maxIntStr: null,
          minIntStr: null,
          bigIntStr: null,
          highPrecisionStr: null,
          negativeNumStr: null,
          boolTrueStr: null,
          boolFalseStr: null,
          boolOneStr: null,
          boolZeroStr: null,
          jsonStr: null,
          unicodeText: null
        });
        if (!res.returning?.[0]?.id) throw new Error('NULL edge case record insert failed');
        this.savedIds.edgeCaseNullId = res.returning[0].id;
      });

      await this.runAssertion('Insert boundary extremes and text variants into edge_case_records', async () => {
        const res = await this.client.insert(this.schema, 'edge_case_records', {
          tenantId: 'tenant_pm_1',
          nullStrToInt: null,
          nullNumToStr: null,
          nullBoolToStr: null,
          nullTsToDate: null,
          maxIntStr: '2147483647',
          minIntStr: '-2147483648',
          bigIntStr: '9223372036854775806',
          highPrecisionStr: '123456789.987654',
          negativeNumStr: '-9999.75',
          boolTrueStr: 'true',
          boolFalseStr: 'false',
          boolOneStr: '1',
          boolZeroStr: '0',
          jsonStr: JSON.stringify({ gateway: 'razorpay', fee: 125.50, meta: { tier: 'enterprise', active: true } }),
          unicodeText: "Payment 🚀 ₹50,000 日本語 \"O'Connor\" ; DROP TABLE --"
        });
        if (!res.returning?.[0]?.id) throw new Error('Boundary extremes edge case record insert failed');
        this.savedIds.edgeCaseBoundaryId = res.returning[0].id;
      });
    });

    // ── STEP 14: Edge Cases & Boundaries ────────────────────────────────────
    await this.executeStep(14, 'edge-cases-and-boundaries', async (stepDiff) => {
      // 1. Verify Diff Engine detected ALTER_COLUMN_TYPE for edge_case_records
      await this.runAssertion('Verify diff detected ALTER_COLUMN_TYPE for all boundary columns', async () => {
        const alters = stepDiff.diffs?.filter(d => d.action === 'ALTER_COLUMN_TYPE' && d.table === 'edge_case_records') || [];
        if (alters.length < 13) throw new Error(`Expected at least 13 edge case alters, got ${alters.length}`);
      });

      // 2. Verify NULL Preservation Across All Types
      await this.runAssertion('Verify NULL preservation across converted types (NULL string, int, bool, ts)', async () => {
        const res = await this.client.select(this.schema, 'edge_case_records', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: this.savedIds.edgeCaseNullId }]
        });
        const row = res.data?.[0];
        if (!row) throw new Error('NULL edge case record not found');
        if (row.nullStrToInt !== null) throw new Error(`nullStrToInt not null: ${row.nullStrToInt}`);
        if (row.nullNumToStr !== null) throw new Error(`nullNumToStr not null: ${row.nullNumToStr}`);
        if (row.nullBoolToStr !== null) throw new Error(`nullBoolToStr not null: ${row.nullBoolToStr}`);
        if (row.nullTsToDate !== null) throw new Error(`nullTsToDate not null: ${row.nullTsToDate}`);
        if (row.maxIntStr !== null) throw new Error(`maxIntStr not null: ${row.maxIntStr}`);
        if (row.bigIntStr !== null) throw new Error(`bigIntStr not null: ${row.bigIntStr}`);
        if (row.highPrecisionStr !== null) throw new Error(`highPrecisionStr not null: ${row.highPrecisionStr}`);
        if (row.boolTrueStr !== null) throw new Error(`boolTrueStr not null: ${row.boolTrueStr}`);
        if (row.jsonStr !== null) throw new Error(`jsonStr not null: ${row.jsonStr}`);
        if (row.unicodeText !== null) throw new Error(`unicodeText not null: ${row.unicodeText}`);
      });

      // 3. Verify Boundary Numeric Extremes
      await this.runAssertion('Verify numeric extremes: INT4 Max (2147483647) and Min (-2147483648)', async () => {
        const res = await this.client.select(this.schema, 'edge_case_records', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: this.savedIds.edgeCaseBoundaryId }]
        });
        const row = res.data?.[0];
        if (!row) throw new Error('Boundary row not found');
        if (row.maxIntStr !== 2147483647) throw new Error(`Expected INT4 max 2147483647, got ${row.maxIntStr}`);
        if (row.minIntStr !== -2147483648) throw new Error(`Expected INT4 min -2147483648, got ${row.minIntStr}`);
      });

      await this.runAssertion('Verify 64-bit BigInt boundary (9223372036854775806)', async () => {
        const res = await this.client.select(this.schema, 'edge_case_records', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: this.savedIds.edgeCaseBoundaryId }]
        });
        const row = res.data?.[0];
        if (String(row.bigIntStr) !== '9223372036854775806') throw new Error(`Expected BigInt 9223372036854775806, got ${row.bigIntStr}`);
      });

      await this.runAssertion('Verify High-Precision Decimal (123456789.987654) and Negative (-9999.75)', async () => {
        const res = await this.client.select(this.schema, 'edge_case_records', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: this.savedIds.edgeCaseBoundaryId }]
        });
        const row = res.data?.[0];
        if (parseFloat(row.highPrecisionStr) !== 123456789.987654) throw new Error(`Expected highPrecision 123456789.987654, got ${row.highPrecisionStr}`);
        if (parseFloat(row.negativeNumStr) !== -9999.75) throw new Error(`Expected negative -9999.75, got ${row.negativeNumStr}`);
      });

      // 4. Verify Boolean Text Variants
      await this.runAssertion('Verify boolean text variants converted to native booleans ("true", "false", "1", "0")', async () => {
        const res = await this.client.select(this.schema, 'edge_case_records', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: this.savedIds.edgeCaseBoundaryId }]
        });
        const row = res.data?.[0];
        if (row.boolTrueStr !== true) throw new Error(`Expected boolTrueStr true, got ${row.boolTrueStr}`);
        if (row.boolFalseStr !== false) throw new Error(`Expected boolFalseStr false, got ${row.boolFalseStr}`);
        if (row.boolOneStr !== true) throw new Error(`Expected boolOneStr true, got ${row.boolOneStr}`);
        if (row.boolZeroStr !== false) throw new Error(`Expected boolZeroStr false, got ${row.boolZeroStr}`);
      });

      // 5. Verify JSON Text to Native JSONB
      await this.runAssertion('Verify JSON text converted to native JSONB and metadata extraction', async () => {
        const res = await this.client.select(this.schema, 'edge_case_records', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: this.savedIds.edgeCaseBoundaryId }]
        });
        const row = res.data?.[0];
        const parsed = typeof row.jsonStr === 'string' ? JSON.parse(row.jsonStr) : row.jsonStr;
        if (parsed?.gateway !== 'razorpay') throw new Error(`Expected gateway razorpay, got ${parsed?.gateway}`);
        if (parsed?.fee !== 125.50) throw new Error(`Expected fee 125.50, got ${parsed?.fee}`);
        if (parsed?.meta?.tier !== 'enterprise') throw new Error(`Expected meta tier enterprise, got ${parsed?.meta?.tier}`);
      });

      // 6. Verify Unicode, Multi-lingual Scripts & Quotes
      await this.runAssertion('Verify multi-lingual text, emojis, and quotes survived type alteration', async () => {
        const res = await this.client.select(this.schema, 'edge_case_records', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: this.savedIds.edgeCaseBoundaryId }]
        });
        const row = res.data?.[0];
        const expected = "Payment 🚀 ₹50,000 日本語 \"O'Connor\" ; DROP TABLE --";
        if (row.unicodeText !== expected) throw new Error(`Unicode text mismatch. Expected: ${expected}, Got: ${row.unicodeText}`);
      });

      // 7. Direct INSERT on Converted Schema
      await this.runAssertion('Direct INSERT on converted edge case table', async () => {
        const res = await this.client.insert(this.schema, 'edge_case_records', {
          tenantId: 'tenant_pm_1',
          nullStrToInt: 42,
          nullNumToStr: '42_as_string',
          nullBoolToStr: 'active_true',
          nullTsToDate: '2026-10-26',
          maxIntStr: 100000,
          minIntStr: -50000,
          bigIntStr: '5000000000',
          highPrecisionStr: '88888.88',
          negativeNumStr: '-42.00',
          boolTrueStr: false,
          boolFalseStr: true,
          boolOneStr: false,
          boolZeroStr: true,
          jsonStr: { source: 'direct_insert', valid: true },
          unicodeText: 'Direct insert edge case 🌟'
        });
        if (!res.returning?.[0]?.id) throw new Error('Direct insert on converted table failed');
        this.savedIds.edgeCaseDirectId = res.returning[0].id;
      });

      // 8. Direct UPDATE on Converted Schema
      await this.runAssertion('Direct UPDATE on converted edge case table', async () => {
        const res = await this.client.update(
          this.schema,
          'edge_case_records',
          {
            maxIntStr: 999999,
            boolTrueStr: false,
            negativeNumStr: '-1.00'
          },
          { id: { $eq: this.savedIds.edgeCaseDirectId } }
        );
        if (res.rowCount !== 1) throw new Error('Update on converted table failed');
      });

      // 9. Negative Edge Cases & Boundary Rejections via Data Fabric API (Pure AST)
      await this.runAssertion('Negative Edge Case 1: Rejection of Integer Overflow via AST INSERT', async () => {
        let err = null;
        try {
          await this.client.insert(this.schema, 'edge_case_records', {
            tenantId: 'tenant_pm_1',
            maxIntStr: '9999999999999999999'
          });
        } catch (e) {
          err = e;
        }
        if (!err) throw new Error('Expected integer out of range error via Data Fabric API');
      });

      await this.runAssertion('Negative Edge Case 2: Rejection of Decimal String to Integer via AST INSERT', async () => {
        let err = null;
        try {
          await this.client.insert(this.schema, 'edge_case_records', {
            tenantId: 'tenant_pm_1',
            maxIntStr: '123.45'
          });
        } catch (e) {
          err = e;
        }
        if (!err) throw new Error('Expected invalid input syntax for integer via Data Fabric API');
      });

      await this.runAssertion('Negative Edge Case 3: Rejection of Empty String to Integer via AST INSERT', async () => {
        let err = null;
        try {
          await this.client.insert(this.schema, 'edge_case_records', {
            tenantId: 'tenant_pm_1',
            maxIntStr: ''
          });
        } catch (e) {
          err = e;
        }
        if (!err) throw new Error('Expected invalid input syntax for integer on empty string via Data Fabric API');
      });

      await this.runAssertion('Negative Edge Case 4: Rejection of Invalid Boolean string ("maybe") via AST INSERT', async () => {
        let err = null;
        try {
          await this.client.insert(this.schema, 'edge_case_records', {
            tenantId: 'tenant_pm_1',
            boolTrueStr: 'maybe'
          });
        } catch (e) {
          err = e;
        }
        if (!err) throw new Error('Expected invalid input syntax for boolean via Data Fabric API');
      });

      await this.runAssertion('Negative Edge Case 5: Rejection of Malformed JSON string to JSONB via AST INSERT', async () => {
        let err = null;
        try {
          await this.client.insert(this.schema, 'edge_case_records', {
            tenantId: 'tenant_pm_1',
            jsonStr: '{bad json: true'
          });
        } catch (e) {
          err = e;
        }
        if (!err) throw new Error('Expected invalid input syntax for JSONB via Data Fabric API');
      });

      await this.runAssertion('Negative Edge Case 6: Rejection of String Narrowing Truncation via Data Fabric Manifest Apply', async () => {
        const manifest14 = JSON.parse(fs.readFileSync(path.join(this.manifestsDir, '14-edge-cases-and-boundaries.json'), 'utf8'));
        const invalidManifest = JSON.parse(JSON.stringify(manifest14));
        const edgeTable = invalidManifest.schemas[0].resources.find(r => r.name === 'edge_case_records');
        const unicodeCol = edgeTable.columns.find(c => c.name === 'unicodeText');
        unicodeCol.type = 'STRING';
        unicodeCol.length = 5; // Existing string has > 30 characters!

        let err = null;
        try {
          await this.client.apply(invalidManifest, true);
        } catch (e) {
          err = e;
        }
        if (!err) throw new Error('Expected truncation rejection via Data Fabric apply');
      });

      // 10. Data Fabric API Level: Attempting impossible conversions through /api/metadata/apply
      await this.runAssertion('Data Fabric API rejection: Impossible String -> INT conversion on alphanumeric data', async () => {
        // payments.orderId contains 'ORD_2026_001'
        const manifest14 = JSON.parse(fs.readFileSync(path.join(this.manifestsDir, '14-edge-cases-and-boundaries.json'), 'utf8'));
        const invalidManifest = JSON.parse(JSON.stringify(manifest14));
        const paymentsTable = invalidManifest.schemas[0].resources.find(r => r.name === 'payments');
        const orderIdCol = paymentsTable.columns.find(c => c.name === 'orderId');
        orderIdCol.type = 'INTEGER';
        delete orderIdCol.length;

        // Verify diff detected the requested change
        const diff = await this.client.diff(invalidManifest);
        const orderDiff = diff.diffs?.find(d => d.table === 'payments' && d.column?.name === 'orderId');
        if (!orderDiff || orderDiff.action !== 'ALTER_COLUMN_TYPE') {
          throw new Error('Diff engine failed to identify ALTER_COLUMN_TYPE for orderId');
        }

        // Verify apply fails gracefully with 500 and clear error
        let caughtErr = null;
        try {
          await this.client.apply(invalidManifest, true);
        } catch (err) {
          caughtErr = err;
        }

        if (!caughtErr) throw new Error('Expected Data Fabric API to reject impossible string-to-int conversion');
        const errDetail = caughtErr.response?.data?.message || caughtErr.message;
        if (!errDetail.includes('invalid input syntax for type integer')) {
          throw new Error(`Expected syntax error for integer, got: ${errDetail}`);
        }

        // Verify atomic rollback through Data Fabric API
        const selectRes = await this.client.select(this.schema, 'payments', {
          limit: 5,
          where: [{ column: 'orderId', operator: 'EQ', value: 'ORD_2026_001' }]
        });
        if (selectRes.data?.[0]?.orderId !== 'ORD_2026_001') {
          throw new Error('Rollback verification failed: payments row missing or altered');
        }
      });

      await this.runAssertion('Data Fabric API rejection: Impossible String -> NUMERIC conversion on email addresses', async () => {
        // customers.email contains 'alex.verified@example.com'
        const manifest14 = JSON.parse(fs.readFileSync(path.join(this.manifestsDir, '14-edge-cases-and-boundaries.json'), 'utf8'));
        const invalidManifest = JSON.parse(JSON.stringify(manifest14));
        const customersTable = invalidManifest.schemas[0].resources.find(r => r.name === 'customers');
        const emailCol = customersTable.columns.find(c => c.name === 'email');
        emailCol.type = 'NUMERIC';
        delete emailCol.length;

        let caughtErr = null;
        try {
          await this.client.apply(invalidManifest, true);
        } catch (err) {
          caughtErr = err;
        }

        if (!caughtErr) throw new Error('Expected Data Fabric API to reject string-to-numeric conversion on email');
        const errDetail = caughtErr.response?.data?.message || caughtErr.message;
        if (!errDetail.includes('invalid input syntax for type numeric')) {
          throw new Error(`Expected syntax error for numeric, got: ${errDetail}`);
        }

        // Verify customers email is untouched
        const selectRes = await this.client.select(this.schema, 'customers', {
          limit: 5,
          where: [{ column: 'email', operator: 'EQ', value: 'alex.verified@example.com' }]
        });
        if (selectRes.data?.[0]?.email !== 'alex.verified@example.com') {
          throw new Error('Rollback verification failed: customers email corrupted');
        }
      });
    });

    // ── STEP 15: Views & Materialized Views ─────────────────────────────────
    await this.executeStep(15, 'views-and-materialized-views', async (stepDiff) => {
      // 1. Verify Diff Engine detected CREATE_VIEW and CREATE_MATERIALIZED_VIEW
      await this.runAssertion('Verify diff detected CREATE_VIEW and CREATE_MATERIALIZED_VIEW', async () => {
        const viewDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_VIEW' && d.name === 'view_high_value_ranked_payments');
        const mvDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_MATERIALIZED_VIEW' && d.name === 'mv_tenant_revenue_analytics');
        if (!viewDiff) throw new Error('CREATE_VIEW not detected in diff');
        if (!mvDiff) throw new Error('CREATE_MATERIALIZED_VIEW not detected in diff');
      });

      // 2. Query and Assert Declarative View (CTE + Window Functions + Multi-Table JOIN + Expressions)
      await this.runAssertion('Query Declarative VIEW: verify CTE, RANK, DENSE_RANK, ROW_NUMBER, JOIN, and expressions', async () => {
        const res = await this.client.select(this.schema, 'view_high_value_ranked_payments', {
          limit: 10
        });
        if (!res.data || res.data.length === 0) throw new Error('Declarative view returned 0 rows');
        const topPayment = res.data[0];
        if (!topPayment.id) throw new Error('Payment id missing from view');
        if (topPayment.payment_rank !== '1' && topPayment.payment_rank !== 1) throw new Error(`Expected rank 1, got ${topPayment.payment_rank}`);
        if (!topPayment.estimated_tax) throw new Error('Computed expression estimated_tax missing from view');
        if (!topPayment.name) throw new Error('Joined tenant name missing from view');
      });

      // 3. Query and Assert Declarative Materialized View (Aggregates + Window Function + Group By + Having)
      await this.runAssertion('Query Declarative MATERIALIZED VIEW: verify COUNT, SUM, AVG, MAX, MIN, and tenant_rank', async () => {
        const res = await this.client.select(this.schema, 'mv_tenant_revenue_analytics', {
          limit: 10
        });
        if (!res.data || res.data.length === 0) throw new Error('Materialized view returned 0 rows');
        const summary = res.data[0];
        if (!summary.tenantId) throw new Error('tenantId missing from materialized view');
        if (parseFloat(summary.total_revenue) <= 0) throw new Error(`Invalid total_revenue: ${summary.total_revenue}`);
        if (parseInt(summary.total_payments, 10) <= 0) throw new Error(`Invalid total_payments: ${summary.total_payments}`);
        if (!summary.tenant_rank) throw new Error('tenant_rank window function missing from materialized view');
      });

      // 4. Verify Secondary B-Tree Indexes on Materialized View
      await this.runAssertion('Verify Secondary B-Tree indexes declared on Materialized View in diff', async () => {
        const mvDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_MATERIALIZED_VIEW' && d.name === 'mv_tenant_revenue_analytics');
        if (!mvDiff || !mvDiff.indexes || mvDiff.indexes.length < 2) {
          throw new Error('Materialized view indexes missing from diff');
        }
      });

      // 5. Test Materialized View Refresh Lifecycle
      await this.runAssertion('Materialized View Refresh Lifecycle: snapshot isolation and Data Fabric refreshView verification', async () => {
        // Query current revenue
        const beforeRes = await this.client.select(this.schema, 'mv_tenant_revenue_analytics', {
          limit: 5,
          where: [{ column: 'tenantId', operator: 'EQ', value: 'tenant_pm_1' }]
        });
        const initialRev = parseFloat(beforeRes.data[0].total_revenue);

        // Insert new high-value captured payment
        await this.client.insert(this.schema, 'payments', {
          tenantId: 'tenant_pm_1',
          orderId: 'ORD_MV_REFRESH_TEST',
          amount: 50000.00,
          currency: 'INR',
          status: 'captured'
        });

        // Verify snapshot isolation: materialized view data does NOT change before refresh
        const duringRes = await this.client.select(this.schema, 'mv_tenant_revenue_analytics', {
          limit: 5,
          where: [{ column: 'tenantId', operator: 'EQ', value: 'tenant_pm_1' }]
        });
        if (parseFloat(duringRes.data[0].total_revenue) !== initialRev) {
          throw new Error('Materialized view snapshot leaked un-refreshed data');
        }

        // Trigger Data Fabric API refresh-view
        await this.client.refreshView('mv_tenant_revenue_analytics', this.schema);
        await new Promise(r => setTimeout(r, 400));

        // Verify updated revenue after refresh
        const afterRes = await this.client.select(this.schema, 'mv_tenant_revenue_analytics', {
          limit: 5,
          where: [{ column: 'tenantId', operator: 'EQ', value: 'tenant_pm_1' }]
        });
        const expectedRev = initialRev + 50000.00;
        if (parseFloat(afterRes.data[0].total_revenue) !== expectedRev) {
          throw new Error(`Expected revenue ${expectedRev} after refresh, got ${afterRes.data[0].total_revenue}`);
        }
      });

      // 6. Direct Query API: Window Functions (RANK, DENSE_RANK, ROW_NUMBER)
      await this.runAssertion('Direct Query API: Window functions (RANK, DENSE_RANK, ROW_NUMBER) evaluation', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 5,
          query: {
            select: [
              'id',
              'amount',
              { window: 'RANK', partitionBy: ['tenantId'], orderBy: [{ column: 'amount', direction: 'DESC' }], alias: 'win_rank' },
              { window: 'DENSE_RANK', partitionBy: ['tenantId'], orderBy: [{ column: 'amount', direction: 'DESC' }], alias: 'win_dense' },
              { window: 'ROW_NUMBER', partitionBy: ['tenantId'], orderBy: [{ column: 'amount', direction: 'DESC' }], alias: 'win_num' }
            ],
            from: { resource: 'payments' },
            where: [{ column: 'status', operator: 'EQ', value: 'captured' }],
            orderBy: [{ column: 'amount', direction: 'DESC' }]
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('Direct window query returned 0 rows');
        const rankOne = res.data.find(r => r.win_rank === 1 || r.win_rank === '1');
        if (!rankOne) throw new Error('Window rank 1 not found');
        if (parseFloat(rankOne.amount) !== 50000.00) throw new Error(`Expected rank 1 amount 50000, got ${rankOne.amount}`);
      });

      // 7. Direct Query API: Multi-way nested JOIN (payments -> tenants -> customers)
      await this.runAssertion('Direct Query API: Multi-way relational JOIN across 3 tables', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 5,
          query: {
            select: ['payments.orderId', 'payments.amount', 'tenants.name', 'customers.email'],
            from: { resource: 'payments' },
            joins: [
              { type: 'INNER', resource: 'tenants', on: { left: 'payments.tenantId', operator: 'EQ', right: 'tenants.id' } },
              { type: 'LEFT', resource: 'customers', on: { left: 'payments.customerId', operator: 'EQ', right: 'customers.customerId' } }
            ]
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('Multi-way join query returned 0 rows');
      });

      // 8. Direct Query API: Set Operations (UNION)
      await this.runAssertion('Direct Query API: Set operation (UNION) between segmented subqueries', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          query: {
            union: [
              {
                select: ['id', 'amount', 'status'],
                from: { resource: 'payments' },
                where: [{ column: 'amount', operator: 'GT', value: 10000 }]
              },
              {
                select: ['id', 'amount', 'status'],
                from: { resource: 'payments' },
                where: [{ column: 'amount', operator: 'LT', value: 5000 }]
              }
            ],
            orderBy: [{ column: 'amount', direction: 'DESC' }],
            limit: 10
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('UNION query returned 0 rows');
      });
    });

    // ── STEP 16: Sequences, Functions & Recursive Functions ─────────────────
    await this.executeStep(16, 'sequences-and-custom-functions', async (stepDiff) => {
      // 1. Verify diff detected sequence, functions, procedure, and invoices table
      await this.runAssertion('Verify diff detected CREATE_SEQUENCE, CREATE_FUNCTION, and CREATE_PROCEDURE', async () => {
        const seqDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_SEQUENCE' && d.name === 'seq_invoice_number');
        const fnDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_FUNCTION' && d.name === 'calculate_processing_fee');
        const recDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_FUNCTION' && d.name === 'calculate_referral_bonus');
        const procDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_PROCEDURE' && d.name === 'mark_batch_settled');
        const tblDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_TABLE' && d.table === 'invoices');
        if (!seqDiff) throw new Error('CREATE_SEQUENCE not found in diff');
        if (!fnDiff) throw new Error('CREATE_FUNCTION not found in diff');
        if (!recDiff) throw new Error('Recursive CREATE_FUNCTION not found in diff');
        if (!procDiff) throw new Error('CREATE_PROCEDURE not found in diff');
        if (!tblDiff) throw new Error('invoices CREATE_TABLE not found in diff');
      });

      // 2. INSERT into invoices (verifying sequence default value auto-generation via AST)
      await this.runAssertion('INSERT into invoices via AST without invoiceNumber (verifying sequence default)', async () => {
        const res = await this.client.insert(this.schema, 'invoices', {
          tenantId: 'tenant_pm_1',
          amount: 25000.00,
          fee: 305.00,
          status: 'issued'
        });
        if (!res.returning?.[0]?.id) throw new Error('Invoices insert failed');
        this.savedIds.invoice1Id = res.returning[0].id;
      });

      // 3. Query invoices via AST SELECT: verify sequence generated number >= 10001
      await this.runAssertion('Query invoices via AST: verify sequence auto-increment value >= 10001', async () => {
        const res = await this.client.select(this.schema, 'invoices', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: this.savedIds.invoice1Id }]
        });
        const inv = res.data?.[0];
        if (!inv) throw new Error('Invoice not found');
        const invNum = parseInt(inv.invoiceNumber, 10);
        if (isNaN(invNum) || invNum < 10001) throw new Error(`Expected sequence invoiceNumber >= 10001, got ${inv.invoiceNumber}`);
      });

      // 4. Invoke custom scalar function via native Data Fabric AST CALL
      await this.runAssertion('AST CALL with custom function: calculate_processing_fee(25000.00, "enterprise")', async () => {
        const res = await this.client.query({
          type: 'CALL',
          schema: this.schema,
          function: 'calculate_processing_fee',
          args: [25000.00, 'enterprise']
        });
        const row = res.data?.[0];
        if (!row || !row.calculate_processing_fee) throw new Error('calculate_processing_fee result missing from AST CALL');
        if (parseFloat(row.calculate_processing_fee) !== 305.00) throw new Error(`Expected fee 305.00, got ${row.calculate_processing_fee}`);
      });

      // 5. Invoke custom recursive function via native Data Fabric AST CALL
      await this.runAssertion('AST CALL with recursive function: calculate_referral_bonus(1000.00, 3)', async () => {
        const res = await this.client.query({
          type: 'CALL',
          schema: this.schema,
          function: 'calculate_referral_bonus',
          args: [1000.00, 3]
        });
        const row = res.data?.[0];
        if (!row || !row.calculate_referral_bonus) throw new Error('calculate_referral_bonus result missing from AST CALL');
        if (parseFloat(row.calculate_referral_bonus) !== 91.67) throw new Error(`Expected recursive bonus 91.67, got ${row.calculate_referral_bonus}`);
      });

      // 6. Invoke stored procedure via native Data Fabric AST CALL
      await this.runAssertion('AST CALL with stored procedure: mark_batch_settled("tenant_pm_1")', async () => {
        const res = await this.client.query({
          type: 'CALL',
          schema: this.schema,
          procedure: 'mark_batch_settled',
          args: ['tenant_pm_1']
        });
        if (res.plan?.strategy !== 'FUNCTION_CALL') throw new Error('Expected FUNCTION_CALL strategy in procedure execution plan');
      });

      // 6. UPDATE invoices status via AST UPDATE
      await this.runAssertion('UPDATE invoices status to "settled" via AST UPDATE', async () => {
        const res = await this.client.update(
          this.schema,
          'invoices',
          { status: 'settled' },
          { id: { $eq: this.savedIds.invoice1Id } }
        );
        if (res.rowCount !== 1) throw new Error('Invoice update failed');
      });
    });

    // ── STEP 17: Recursive CTEs, CHECK Constraints & Triggers ────────────────
    await this.executeStep(17, 'recursive-ctes-and-triggers', async (stepDiff) => {
      // 1. Verify diff detected new tables and recursive view
      await this.runAssertion('Verify diff detected affiliate_referrals, order_discounts, and view_affiliate_hierarchy_tree', async () => {
        const affDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_TABLE' && d.table === 'affiliate_referrals');
        const discDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_TABLE' && d.table === 'order_discounts');
        const viewDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_VIEW' && d.name === 'view_affiliate_hierarchy_tree');
        if (!affDiff) throw new Error('affiliate_referrals table not found in diff');
        if (!discDiff) throw new Error('order_discounts table not found in diff');
        if (!viewDiff) throw new Error('view_affiliate_hierarchy_tree view not found in diff');
      });

      // 2. Insert hierarchical referral tree records via AST INSERT
      await this.runAssertion('Insert multi-level hierarchy into affiliate_referrals via AST INSERT', async () => {
        // Root Affiliate (Level 0)
        const root = await this.client.insert(this.schema, 'affiliate_referrals', {
          tenantId: 'tenant_pm_1',
          parentAffiliateId: null,
          affiliateName: 'Global Partner Corp',
          tier: 'platinum',
          commissionRate: 0.10
        });
        this.savedIds.rootAffId = root.returning[0].id;

        // Level 1 Child
        const l1 = await this.client.insert(this.schema, 'affiliate_referrals', {
          tenantId: 'tenant_pm_1',
          parentAffiliateId: this.savedIds.rootAffId,
          affiliateName: 'Regional Apex Agency',
          tier: 'gold',
          commissionRate: 0.07
        });
        this.savedIds.l1AffId = l1.returning[0].id;

        // Level 2 Grandchild
        const l2 = await this.client.insert(this.schema, 'affiliate_referrals', {
          tenantId: 'tenant_pm_1',
          parentAffiliateId: this.savedIds.l1AffId,
          affiliateName: 'Local Branch Network',
          tier: 'silver',
          commissionRate: 0.05
        });
        this.savedIds.l2AffId = l2.returning[0].id;
      });

      // 3. Query Recursive CTE View via AST: view_affiliate_hierarchy_tree
      await this.runAssertion('Query Declarative View with RECURSIVE CTE: verify level 0, 1, 2 traversal', async () => {
        const res = await this.client.select(this.schema, 'view_affiliate_hierarchy_tree', {
          limit: 10,
          orderBy: [{ column: 'level', direction: 'ASC' }]
        });
        if (!res.data || res.data.length < 3) throw new Error(`Expected at least 3 hierarchy nodes, got ${res.data?.length}`);
        if (res.data[0].level !== 0 && res.data[0].level !== '0') throw new Error(`Expected root level 0, got ${res.data[0].level}`);
        if (res.data[1].level !== 1 && res.data[1].level !== '1') throw new Error(`Expected child level 1, got ${res.data[1].level}`);
        if (res.data[2].level !== 2 && res.data[2].level !== '2') throw new Error(`Expected grandchild level 2, got ${res.data[2].level}`);
      });

      // 4. CHECK Constraint Verification (Valid Insert via AST)
      await this.runAssertion('CHECK Constraint: valid discount record insertion (discountPercent = 25) via AST', async () => {
        const res = await this.client.insert(this.schema, 'order_discounts', {
          tenantId: 'tenant_pm_1',
          code: 'PROMO_VALID_25',
          discountPercent: 25,
          amountSaved: 250.00
        });
        if (!res.returning?.[0]?.id) throw new Error('Valid discount insert failed');
        this.savedIds.discountId = res.returning[0].id;
      });

      // 5. CHECK Constraint Enforcement: Rejection of invalid value (discountPercent = 150 > 100) via AST
      await this.runAssertion('CHECK Constraint Rejection: discountPercent = 150 rejected via Data Fabric API', async () => {
        let caughtErr = null;
        try {
          await this.client.insert(this.schema, 'order_discounts', {
            tenantId: 'tenant_pm_1',
            code: 'PROMO_INVALID_150',
            discountPercent: 150,
            amountSaved: 50.00
          });
        } catch (err) {
          caughtErr = err;
        }
        if (!caughtErr) throw new Error('Expected CHECK constraint violation on discountPercent > 100');
      });

      // 6. CHECK Constraint Enforcement: Rejection of negative value (amountSaved = -100) via AST
      await this.runAssertion('CHECK Constraint Rejection: negative amountSaved (-100) rejected via Data Fabric API', async () => {
        let caughtErr = null;
        try {
          await this.client.insert(this.schema, 'order_discounts', {
            tenantId: 'tenant_pm_1',
            code: 'PROMO_NEGATIVE',
            discountPercent: 10,
            amountSaved: -100.00
          });
        } catch (err) {
          caughtErr = err;
        }
        if (!caughtErr) throw new Error('Expected CHECK constraint violation on negative amountSaved');
      });

      // 7. Functional Trigger Table: Insert and verify auto-generated tokenHash
      await this.runAssertion('Functional Trigger: verify automatic tokenHash generation on payment_audit_tokens', async () => {
        const res = await this.client.insert(this.schema, 'payment_audit_tokens', {
          tenantId: 'tenant_pm_1'
        });
        const tokenRecord = res.returning?.[0];
        if (!tokenRecord?.id) throw new Error('Audit token insert failed');
        
        const qRes = await this.client.select(this.schema, 'payment_audit_tokens', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: tokenRecord.id }]
        });
        const row = qRes.data?.[0];
        if (!row?.tokenHash) throw new Error('tokenHash was not populated by functional trigger');
        if (row.tokenHash.length !== 32) throw new Error(`Expected 32-char MD5 tokenHash, got ${row.tokenHash}`);
      });
    });

    // ── STEP 18: Table Partitioning, Stored Generated Columns & Indexes ──────
    await this.executeStep(18, 'partitioning-indexes-and-generated-cols', async (stepDiff) => {
      // 1. Verify diff detected invoices_with_tax and high_volume_audit_partitioned
      await this.runAssertion('Verify diff detected invoices_with_tax and high_volume_audit_partitioned', async () => {
        const invTaxDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_TABLE' && d.table === 'invoices_with_tax');
        const partDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_TABLE' && d.table === 'high_volume_audit_partitioned');
        if (!invTaxDiff) throw new Error('invoices_with_tax not found in diff');
        if (!partDiff) throw new Error('high_volume_audit_partitioned not found in diff');
      });

      // 2. Stored Generated Column: INSERT into invoices_with_tax via AST
      await this.runAssertion('Stored Generated Column: INSERT subtotal (1000.00) and verify taxAmount (180.00)', async () => {
        const res = await this.client.insert(this.schema, 'invoices_with_tax', {
          tenantId: 'tenant_pm_1',
          subtotal: 1000.00
        });
        const insertedId = res.returning?.[0]?.id;
        if (!insertedId) throw new Error('invoices_with_tax insert failed');
        this.savedIds.invTaxId = insertedId;

        const sel = await this.client.select(this.schema, 'invoices_with_tax', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: insertedId }]
        });
        const row = sel.data?.[0];
        if (!row) throw new Error('Inserted invoice_with_tax record not found');
        if (parseFloat(row.taxAmount) !== 180.00) throw new Error(`Expected generated taxAmount 180.00, got ${row.taxAmount}`);
      });

      // 3. Stored Generated Column: UPDATE subtotal and verify automatic recalculation
      await this.runAssertion('Stored Generated Column: UPDATE subtotal to 2500.00 and verify taxAmount (450.00)', async () => {
        await this.client.update(
          this.schema,
          'invoices_with_tax',
          { subtotal: 2500.00 },
          { id: { $eq: this.savedIds.invTaxId } }
        );

        const sel = await this.client.select(this.schema, 'invoices_with_tax', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: this.savedIds.invTaxId }]
        });
        const row = sel.data?.[0];
        if (parseFloat(row.taxAmount) !== 450.00) throw new Error(`Expected updated taxAmount 450.00, got ${row.taxAmount}`);
      });

      // 4. Partitioned Table Query via AST
      await this.runAssertion('Query partitioned table high_volume_audit_partitioned via AST SELECT', async () => {
        const sel = await this.client.select(this.schema, 'high_volume_audit_partitioned', {
          limit: 5
        });
        if (!Array.isArray(sel.data)) throw new Error('Expected array response from partitioned table');
      });
    });

    // ── STEP 19: Security, Row-Level Security (RLS) & Column Masking ─────────
    await this.executeStep(19, 'security-rls-and-masking', async (stepDiff) => {
      // 1. Verify diff detected sensitive_financial_records table
      await this.runAssertion('Verify diff detected sensitive_financial_records with RLS', async () => {
        const tblDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_TABLE' && d.table === 'sensitive_financial_records');
        if (!tblDiff) throw new Error('sensitive_financial_records table not found in diff');
      });

      // 2. INSERT into RLS-enabled table via AST INSERT
      await this.runAssertion('INSERT into sensitive_financial_records via AST for tenant_pm_1', async () => {
        const res = await this.client.insert(this.schema, 'sensitive_financial_records', {
          tenantId: 'tenant_pm_1',
          accountNumber: 'AC_998877665544',
          swiftCode: 'CHASUS33',
          balance: 850000.00,
          isAudited: true
        });
        const recId = res.returning?.[0]?.id;
        if (!recId) throw new Error('Financial record insert failed');
        this.savedIds.financialRecId = recId;
      });

      // 3. SELECT from RLS table via AST SELECT
      await this.runAssertion('SELECT from sensitive_financial_records via AST', async () => {
        const res = await this.client.select(this.schema, 'sensitive_financial_records', {
          limit: 5,
          where: [{ column: 'id', operator: 'EQ', value: this.savedIds.financialRecId }]
        });
        if (res.data?.length !== 1) throw new Error('Expected 1 financial record returned');
        if (parseFloat(res.data[0].balance) !== 850000.00) throw new Error(`Balance mismatch: ${res.data[0].balance}`);
      });

      // 4. UPDATE financial record via AST UPDATE
      await this.runAssertion('UPDATE sensitive_financial_records balance to 920000.00 via AST UPDATE', async () => {
        const res = await this.client.update(
          this.schema,
          'sensitive_financial_records',
          { balance: 920000.00 },
          { id: { $eq: this.savedIds.financialRecId } }
        );
        if (res.rowCount !== 1) throw new Error('Financial record update failed');
      });
    });

    // ── STEP 20: Advanced Query Operations & Analytical AST ──────────────────
    await this.executeStep(20, 'advanced-query-operations', async (stepDiff) => {
      // 1. Verify diff detected settlement_batches
      await this.runAssertion('Verify diff detected settlement_batches table', async () => {
        const tblDiff = stepDiff.diffs?.find(d => d.action === 'CREATE_TABLE' && d.table === 'settlement_batches');
        if (!tblDiff) throw new Error('settlement_batches not found in diff');
      });

      // 2. Insert test settlement batches via AST INSERT
      await this.runAssertion('Insert test settlement batch records via AST INSERT', async () => {
        await this.client.insert(this.schema, 'settlement_batches', {
          tenantId: 'tenant_pm_1',
          batchCode: 'BATCH_2026_Q4_01',
          totalAmount: 150000.00,
          status: 'settled'
        });
        await this.client.insert(this.schema, 'settlement_batches', {
          tenantId: 'tenant_pm_1',
          batchCode: 'BATCH_2026_Q4_02',
          totalAmount: 45000.00,
          status: 'pending'
        });
      });

      // 3. Direct AST Query: Set Operation INTERSECT
      await this.runAssertion('Direct AST Query: INTERSECT set operation between overlapping queries', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          query: {
            intersect: [
              {
                select: ['tenantId', 'status'],
                from: { resource: 'payments' },
                where: [{ column: 'amount', operator: 'GT', value: 1000 }]
              },
              {
                select: ['tenantId', 'status'],
                from: { resource: 'payments' },
                where: [{ column: 'status', operator: 'EQ', value: 'captured' }]
              }
            ],
            limit: 5
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('INTERSECT query returned 0 rows');
      });

      // 4. Direct AST Query: Set Operation EXCEPT
      await this.runAssertion('Direct AST Query: EXCEPT set operation between segmented queries', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          query: {
            except: [
              {
                select: ['status'],
                from: { resource: 'payments' }
              },
              {
                select: ['status'],
                from: { resource: 'payments' },
                where: [{ column: 'status', operator: 'EQ', value: 'authorized' }]
              }
            ],
            limit: 5
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('EXCEPT query returned 0 rows');
        const hasAuth = res.data.some(r => r.status === 'authorized');
        if (hasAuth) throw new Error('EXCEPT failed: authorized rows present in result');
      });

      // 5. Direct AST Query: Derived Subquery in FROM
      await this.runAssertion('Direct AST Query: Derived subquery in FROM (FROM (SELECT ...) AS derived)', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          query: {
            select: ['derived.orderId', 'derived.amount'],
            from: {
              query: {
                select: ['orderId', 'amount'],
                from: { resource: 'payments' },
                where: [{ column: 'amount', operator: 'GT', value: 5000 }]
              },
              alias: 'derived'
            },
            limit: 5
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('Derived query returned 0 rows');
      });

      // 6. Direct AST Query: Window Functions PERCENT_RANK & CUME_DIST
      await this.runAssertion('Direct AST Query: Window functions PERCENT_RANK and CUME_DIST evaluation', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 5,
          query: {
            select: [
              'id',
              'amount',
              { window: 'PERCENT_RANK', partitionBy: ['tenantId'], orderBy: [{ column: 'amount', direction: 'ASC' }], alias: 'pct_rank' },
              { window: 'CUME_DIST', partitionBy: ['tenantId'], orderBy: [{ column: 'amount', direction: 'ASC' }], alias: 'cume_dist' }
            ],
            from: { resource: 'payments' },
            where: [{ column: 'status', operator: 'EQ', value: 'captured' }],
            orderBy: [{ column: 'amount', direction: 'ASC' }]
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('PERCENT_RANK query returned 0 rows');
        if (res.data[0].pct_rank === undefined) throw new Error('pct_rank missing from result');
        if (res.data[0].cume_dist === undefined) throw new Error('cume_dist missing from result');
      });

      // 7. Direct AST Query: Statistical Aggregates (COUNT_DISTINCT, AVG, STDDEV)
      await this.runAssertion('Direct AST Query: Aggregates COUNT_DISTINCT, AVG, and STDDEV', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 5,
          query: {
            select: [
              { aggregate: 'COUNT_DISTINCT', column: 'currency', alias: 'distinct_currencies' },
              { aggregate: 'AVG', column: 'amount', alias: 'average_amount' },
              { aggregate: 'STDDEV', column: 'amount', alias: 'amount_stddev' }
            ],
            from: { resource: 'payments' }
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('Statistical aggregates query returned 0 rows');
        if (res.data[0].distinct_currencies === undefined) throw new Error('distinct_currencies missing');
      });

      // 8. Direct AST Query: Full-Text Search predicate (search operator)
      await this.runAssertion('Direct AST Query: Full-Text Search predicate ({ search: { column, query } })', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 5,
          query: {
            select: ['id', 'description'],
            from: { resource: 'payments' },
            where: [
              { search: { column: 'description', query: 'cloud subscription' } }
            ]
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('Full-text search query returned 0 rows');
        if (!res.data[0].description.toLowerCase().includes('cloud')) {
          throw new Error('FTS returned non-matching description');
        }
      });
    });

    // ── STEP 21: Relationships, M:N Bridge Tables & Extensions ──────────────
    await this.executeStep(21, 'relationships-and-extensions', async () => {
      // 1. Insert into tags table with CITEXT
      let tag1Id;
      await this.runAssertion('Insert tag with CITEXT name', async () => {
        const res = await this.client.insert(this.schema, 'tags', {
          tenantId: 'tenant_pm_1',
          name: 'HighPriority',
          category: 'operational'
        });
        tag1Id = res.returning?.[0]?.id;
        if (!tag1Id) throw new Error('Tag insert failed');
        this.savedIds.tag1Id = tag1Id;
      });

      // 2. Validate CITEXT Case-Insensitive Uniqueness constraint
      await this.runAssertion('Verify CITEXT case-insensitive uniqueness rejects lowercase duplicate', async () => {
        let rejected = false;
        try {
          await this.client.insert(this.schema, 'tags', {
            tenantId: 'tenant_pm_1',
            name: 'highpriority',
            category: 'duplicate_check'
          });
        } catch (err) {
          rejected = true;
        }
        if (!rejected) throw new Error('CITEXT case-insensitive unique constraint did not reject duplicate');
      });

      // 3. Insert and query composite primary key table: tenant_metadata (tenantId + metaKey)
      await this.runAssertion('Insert into tenant_metadata with composite primary key', async () => {
        const res = await this.client.insert(this.schema, 'tenant_metadata', {
          tenantId: 'tenant_pm_1',
          metaKey: 'webhook_timeout_sec',
          metaValue: '30',
          isEncrypted: false
        });
        if (res.rowCount !== 1) throw new Error('tenant_metadata insert failed');
      });

      await this.runAssertion('Fetch tenant_metadata by composite primary key fields', async () => {
        const res = await this.client.select(this.schema, 'tenant_metadata', {
          limit: 5,
          where: [
            { column: 'tenantId', operator: 'EQ', value: 'tenant_pm_1' },
            { column: 'metaKey', operator: 'EQ', value: 'webhook_timeout_sec' }
          ]
        });
        if (res.data?.length !== 1) throw new Error('Composite primary key row not found');
        if (res.data[0].metaValue !== '30') throw new Error('Composite metadata value mismatch');
      });

      // 4. Insert into auto-generated M:N relationship bridge table: invoice_tags_bridge
      await this.runAssertion('Insert link into auto-generated M:N bridge table invoice_tags_bridge', async () => {
        const res = await this.client.insert(this.schema, 'invoice_tags_bridge', {
          invoices_id: this.savedIds.invoice1Id,
          tags_id: tag1Id
        });
        if (res.rowCount !== 1) throw new Error('invoice_tags_bridge insert failed');
      });

      // 5. Query M:N Relationship with JOIN via pure AST
      await this.runAssertion('Query invoices linked to tags via invoice_tags_bridge join', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 10,
          query: {
            select: ['invoices.invoiceNumber', 'tags.name', 'tags.category'],
            from: { resource: 'invoices' },
            joins: [
              {
                type: 'INNER',
                resource: 'invoice_tags_bridge',
                on: { left: 'invoices.id', operator: 'EQ', right: 'invoice_tags_bridge.invoices_id' }
              },
              {
                type: 'INNER',
                resource: 'tags',
                on: { left: 'invoice_tags_bridge.tags_id', operator: 'EQ', right: 'tags.id' }
              }
            ],
            where: [{ column: 'invoices.id', operator: 'EQ', value: this.savedIds.invoice1Id }]
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('M:N relationship join returned 0 rows');
        if (res.data[0].name !== 'HighPriority') throw new Error(`Tag name mismatch: ${res.data[0].name}`);
      });
    });

    // ── STEP 22: Exclusion Constraints & Function Parameter Modes ───────────
    await this.executeStep(22, 'exclusion-constraints-and-param-modes', async () => {
      // 1. Insert valid non-overlapping operating window
      await this.runAssertion('Insert valid operating window with INT4RANGE slotRange', async () => {
        const res = await this.client.insert(this.schema, 'merchant_operating_windows', {
          tenantId: 'tenant_pm_1',
          slotRange: '[100, 200)',
          channel: 'card',
          status: 'active'
        });
        if (!res.returning?.[0]?.id) throw new Error('Operating window insert failed');
      });

      // 2. Validate EXCLUDE constraint prevents overlapping slotRange for same tenant
      await this.runAssertion('Verify EXCLUDE constraint rejects overlapping slot range for same tenant', async () => {
        let rejected = false;
        try {
          await this.client.insert(this.schema, 'merchant_operating_windows', {
            tenantId: 'tenant_pm_1',
            slotRange: '[150, 250)',
            channel: 'card',
            status: 'active'
          });
        } catch (err) {
          rejected = true;
        }
        if (!rejected) throw new Error('EXCLUDE constraint did not reject overlapping range');
      });

      // 3. Different tenant can have overlapping slotRange
      await this.runAssertion('Allow overlapping range for DIFFERENT tenant under EXCLUDE constraint', async () => {
        const res = await this.client.insert(this.schema, 'merchant_operating_windows', {
          tenantId: 'tenant_pm_2',
          slotRange: '[150, 250)',
          channel: 'card',
          status: 'active'
        });
        if (!res.returning?.[0]?.id) throw new Error('Operating window for tenant_pm_2 insert failed');
      });

      // 4. Invoke custom function calculate_tiered_rebate with AST CALL and IN parameter mode
      await this.runAssertion('Invoke custom function calculate_tiered_rebate with sales_volume > 100k', async () => {
        const res = await this.client.query({
          type: 'CALL',
          schema: this.schema,
          function: 'calculate_tiered_rebate',
          args: [150000.00]
        });
        const rows = res.data || [];
        if (rows.length === 0) throw new Error('Function CALL returned no rows');
        const rebate = parseFloat(rows[0].calculate_tiered_rebate || rows[0].result || Object.values(rows[0])[0]);
        if (rebate !== 7500) throw new Error(`Expected rebate 7500, got ${rebate}`);
      });

      await this.runAssertion('Invoke custom function calculate_tiered_rebate with sales_volume <= 100k', async () => {
        const res = await this.client.query({
          type: 'CALL',
          schema: this.schema,
          function: 'calculate_tiered_rebate',
          args: [50000.00]
        });
        const rows = res.data || [];
        const rebate = parseFloat(rows[0].calculate_tiered_rebate || rows[0].result || Object.values(rows[0])[0]);
        if (rebate !== 1000) throw new Error(`Expected rebate 1000, got ${rebate}`);
      });
    });

    // ── STEP 23: In-Fabric Graph Traversal & Analytics ───────────────────────
    await this.executeStep(23, 'in-fabric-graph-and-analytics', async () => {
      let rootNodeId, divisionNodeId, teamNodeId;

      // 1. Insert 3-level organization hierarchy
      await this.runAssertion('Insert organization hierarchy root node (depth 0)', async () => {
        const res = await this.client.insert(this.schema, 'organization_hierarchy', {
          tenantId: 'tenant_pm_1',
          parentId: null,
          nodeName: 'Global HQ',
          department: 'Executive',
          budget: 5000000.00
        });
        rootNodeId = res.returning?.[0]?.id;
        if (!rootNodeId) throw new Error('Hierarchy root insert failed');
      });

      await this.runAssertion('Insert organization hierarchy child division (depth 1)', async () => {
        const res = await this.client.insert(this.schema, 'organization_hierarchy', {
          tenantId: 'tenant_pm_1',
          parentId: rootNodeId,
          nodeName: 'Payments Engineering',
          department: 'Technology',
          budget: 1500000.00
        });
        divisionNodeId = res.returning?.[0]?.id;
        if (!divisionNodeId) throw new Error('Hierarchy division insert failed');
      });

      await this.runAssertion('Insert organization hierarchy grandchild team (depth 2)', async () => {
        const res = await this.client.insert(this.schema, 'organization_hierarchy', {
          tenantId: 'tenant_pm_1',
          parentId: divisionNodeId,
          nodeName: 'Settlement Gateway Squad',
          department: 'Technology',
          budget: 450000.00
        });
        teamNodeId = res.returning?.[0]?.id;
        if (!teamNodeId) throw new Error('Hierarchy squad insert failed');
      });

      // 2. Query hierarchy via In-Fabric Recursive Graph BFS Traversal (RecursiveExecutor)
      await this.runAssertion('Query organization hierarchy via In-Fabric Recursive BFS traversal', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          query: {
            recursive: {
              resource: 'organization_hierarchy',
              connectBy: { parent: 'parentId', child: 'id' },
              direction: 'down',
              maxDepth: 5,
              pathColumn: 'nodeName'
            }
          }
        });
        const rows = res.data || [];
        if (rows.length < 3) throw new Error(`Expected at least 3 hierarchy nodes, got ${rows.length}`);

        const root = rows.find(r => r.nodeName === 'Global HQ');
        const division = rows.find(r => r.nodeName === 'Payments Engineering');
        const squad = rows.find(r => r.nodeName === 'Settlement Gateway Squad');

        const getDepth = (n) => n.__depth !== undefined ? n.__depth : n.depth;
        const getPath = (n) => n.__path !== undefined ? n.__path : n.path;

        if (!root || getDepth(root) !== 0) throw new Error('Root node depth is not 0');
        if (!division || getDepth(division) !== 1) throw new Error('Division node depth is not 1');
        if (!squad || getDepth(squad) !== 2) throw new Error('Squad node depth is not 2');

        const squadPath = getPath(squad);
        if (!Array.isArray(squadPath) || squadPath.length !== 3) {
          throw new Error(`Squad breadcrumb path invalid: ${JSON.stringify(squadPath)}`);
        }
        if (squadPath[0] !== 'Global HQ' || squadPath[2] !== 'Settlement Gateway Squad') {
          throw new Error(`Squad path breadcrumb order incorrect: ${JSON.stringify(squadPath)}`);
        }
      });
    });

    // ── STEP 24: Advanced Engine Features & REST Data APIs ──────────────────
    await this.executeStep(24, 'advanced-engine-features', async () => {
      // 1. Direct AST Query: DISTINCT projection
      await this.runAssertion('Direct AST Query: SELECT DISTINCT currency from payments', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 10,
          query: {
            select: ['currency'],
            from: { resource: 'payments' },
            distinct: true
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('Distinct query returned 0 rows');
        const currencies = res.data.map(r => r.currency);
        const unique = new Set(currencies);
        if (unique.size !== currencies.length) throw new Error('Duplicate currency returned with distinct: true');
      });

      // 2. Direct AST Query: HAVING aggregate filter
      await this.runAssertion('Direct AST Query: GROUP BY with HAVING aggregate filter', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 10,
          query: {
            select: ['status', { aggregate: 'COUNT', column: 'id', alias: 'total_count' }],
            from: { resource: 'payments' },
            groupBy: ['status'],
            having: [{ column: 'total_count', operator: 'GT', value: 0 }]
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('HAVING query returned 0 rows');
        for (const row of res.data) {
          if (Number(row.total_count) <= 0) throw new Error(`HAVING predicate violated: ${row.total_count}`);
        }
      });

      // 3. Direct AST Query: Navigation Window Functions LAG & LEAD
      await this.runAssertion('Direct AST Query: Window functions LAG and LEAD evaluation', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 10,
          query: {
            select: [
              'id',
              'amount',
              { window: 'LAG', column: 'amount', partitionBy: ['tenantId'], orderBy: [{ column: 'amount', direction: 'ASC' }], alias: 'prev_amount' },
              { window: 'LEAD', column: 'amount', partitionBy: ['tenantId'], orderBy: [{ column: 'amount', direction: 'ASC' }], alias: 'next_amount' }
            ],
            from: { resource: 'payments' },
            orderBy: [{ column: 'amount', direction: 'ASC' }]
          }
        });
        if (!res.data || res.data.length < 2) throw new Error('LAG/LEAD query returned insufficient rows');
        if (res.data[0].next_amount === undefined) throw new Error('next_amount missing from LAG/LEAD result');
      });

      // 4. Direct AST Query: Running Window Aggregate SUM
      await this.runAssertion('Direct AST Query: Running cumulative SUM window aggregate', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 10,
          query: {
            select: [
              'id',
              'amount',
              { window: 'SUM', column: 'amount', partitionBy: ['tenantId'], orderBy: [{ column: 'amount', direction: 'ASC' }], alias: 'cumulative_sum' }
            ],
            from: { resource: 'payments' },
            orderBy: [{ column: 'amount', direction: 'ASC' }]
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('Cumulative SUM query returned 0 rows');
        if (res.data[0].cumulative_sum === undefined) throw new Error('cumulative_sum missing from result');
      });

      // 5. Direct AST Query: Statistical & Array Aggregates (ARRAY_AGG, VARIANCE)
      await this.runAssertion('Direct AST Query: Statistical & Array Aggregates ARRAY_AGG and VARIANCE', async () => {
        const res = await this.client.query({
          type: 'SELECT',
          schema: this.schema,
          limit: 5,
          query: {
            select: [
              { aggregate: 'ARRAY_AGG', column: 'currency', alias: 'all_currencies' },
              { aggregate: 'VARIANCE', column: 'amount', alias: 'amount_var' }
            ],
            from: { resource: 'payments' }
          }
        });
        if (!res.data || res.data.length === 0) throw new Error('Statistical & array aggregates query returned 0 rows');
        if (!res.data[0].all_currencies) throw new Error('ARRAY_AGG result missing');
      });

      // 6. Asynchronous Query Execution & Polling (/api/analytics/query-async & /jobs/:id)
      await this.runAssertion('Async Query: Enqueue query-async and poll job status until COMPLETED', async () => {
        const asyncRes = await this.client.post('/analytics/query-async', {
          queryConfig: {
            type: 'SELECT',
            schema: this.schema,
            limit: 5,
            query: {
              select: ['id', 'orderId', 'amount'],
              from: { resource: 'payments' }
            }
          }
        });
        const jobId = asyncRes.jobId;
        if (!jobId) throw new Error('query-async did not return jobId');

        let attempts = 0;
        let jobResult = null;
        while (attempts < 20) {
          await new Promise(r => setTimeout(r, 200));
          const statusRes = await this.client.get(`/analytics/jobs/${jobId}`);
          if (statusRes.status === 'COMPLETED') {
            jobResult = statusRes.result;
            break;
          }
          if (statusRes.status === 'FAILED') {
            throw new Error(`Async job failed: ${statusRes.error}`);
          }
          attempts++;
        }
        if (!jobResult || !jobResult.data) throw new Error('Async job polling timed out or missing result');
      });

      // 7. NDJSON Streaming Query (Accept: application/x-ndjson)
      await this.runAssertion('Streaming Query: Opt-in NDJSON streaming query execution', async () => {
        const streamData = await this.client.queryStream({
          type: 'SELECT',
          schema: this.schema,
          limit: 5,
          query: {
            select: ['id', 'orderId', 'amount'],
            from: { resource: 'payments' }
          }
        });
        if (typeof streamData !== 'string' || !streamData.trim()) {
          throw new Error('Streaming response is not valid NDJSON text');
        }
        const lines = streamData.trim().split('\n');
        if (lines.length < 1) throw new Error('NDJSON stream returned 0 lines');
        const firstLine = JSON.parse(lines[0]);
        if (!firstLine.id && !firstLine.data && !firstLine.rowCount) {
          throw new Error(`Unexpected NDJSON line format: ${lines[0]}`);
        }
      });

      // 8. REST CRUD Endpoints (/api/data): Sequence allocation
      await this.runAssertion('REST CRUD API: Allocate next sequence value via /api/data/sequence', async () => {
        const seqVal = await this.client.nextSequence('seq_invoice_number', 100, 1);
        const val = typeof seqVal === 'object' && seqVal !== null ? seqVal.value : seqVal;
        if (typeof val !== 'number' && typeof val !== 'string') {
          throw new Error(`Unexpected sequence result: ${JSON.stringify(seqVal)}`);
        }
      });

      // 9. REST CRUD Endpoints (/api/data): Create, Fetch, Update, Delete
      await this.runAssertion('REST CRUD API: Create row via /api/data/create', async () => {
        const res = await this.client.createData('tenant_metadata', {
          tenantId: 'tenant_pm_1',
          metaKey: 'rest_crud_test_key',
          metaValue: 'initial_value',
          isEncrypted: false
        });
        if (!res || (res.rowCount !== 1 && res.status !== 'SUCCESS')) {
          throw new Error('createData failed');
        }
      });

      await this.runAssertion('REST CRUD API: Fetch row via /api/data/fetch', async () => {
        const res = await this.client.fetchData('tenant_metadata', {
          where: { tenantId: 'tenant_pm_1', metaKey: 'rest_crud_test_key' }
        });
        const rows = res.data || [];
        if (rows.length !== 1 || rows[0].metaValue !== 'initial_value') {
          throw new Error('fetchData returned incorrect row');
        }
      });

      await this.runAssertion('REST CRUD API: Update row via /api/data/update', async () => {
        const res = await this.client.updateData('tenant_metadata', {
          tenantId: 'tenant_pm_1',
          metaKey: 'rest_crud_test_key'
        }, {
          metaValue: 'updated_via_rest_crud'
        });
        if (!res || (res.rowCount !== 1 && res.status !== 'SUCCESS')) {
          throw new Error('updateData failed');
        }
      });

      await this.runAssertion('REST CRUD API: Delete row via /api/data/delete', async () => {
        const res = await this.client.deleteData('tenant_metadata', {
          tenantId: 'tenant_pm_1',
          metaKey: 'rest_crud_test_key'
        });
        if (!res || (res.rowCount !== 1 && res.status !== 'SUCCESS')) {
          throw new Error('deleteData failed');
        }
      });

      // 10. REST CRUD Endpoints (/api/data): Function invocation via /api/data/call
      await this.runAssertion('REST CRUD API: Invoke function via /api/data/call', async () => {
        const res = await this.client.callFunction('calculate_tiered_rebate', [200000.00]);
        const rows = res.data || [];
        if (rows.length === 0) throw new Error('callFunction returned no rows');
        const rebate = parseFloat(rows[0].calculate_tiered_rebate || rows[0].result || Object.values(rows[0])[0]);
        if (rebate !== 10000) throw new Error(`Expected rebate 10000, got ${rebate}`);
      });

      // 11. Metadata Lineage & History Endpoints
      await this.runAssertion('Catalog Lineage: Verify /api/metadata/relationships returns active relations', async () => {
        const rels = await this.client.get('/metadata/relationships', { params: { schema: this.schema } });
        if (!Array.isArray(rels)) throw new Error('Relationships response is not an array');
        const hasRel = rels.some(r => r.name === 'rel_invoices_tags' || r.name === 'rel_tenants_settlement_batches');
        if (!hasRel) throw new Error('Declared relationships missing from catalog lineage');
      });

      await this.runAssertion('Catalog Governance: Verify /api/metadata/history captures manifest deployments', async () => {
        const history = await this.client.get('/metadata/history');
        if (!Array.isArray(history) || history.length === 0) {
          throw new Error('Metadata history is empty or not an array');
        }
      });
    });

    // ── FINAL PHASE: Data Durability & Integrity Assertion ──────────────────
    logHeader('FINAL VERIFICATION: DATA DURABILITY ACROSS ALL 25 MIGRATIONS');

    await this.runAssertion('Verify Step 00 baseline payment survived all 25 migrations', async () => {
      const res = await this.client.select(this.schema, 'payments', {
        limit: 5,
        where: [{ column: 'id', operator: 'EQ', value: this.savedIds.paymentId }]
      });
      if (res.data?.length !== 1) throw new Error('Baseline payment not found');
      const p = res.data[0];
      if (p.orderId !== 'ORD_2026_001') throw new Error(`OrderId corrupted: ${p.orderId}`);
      if (p.checkoutToken !== 'chk_tok_unique_111222') throw new Error('checkoutToken missing');
      if (p.autoCapture !== true) throw new Error('autoCapture missing');
      if (p.manualReviewStatus !== 'APPROVED') throw new Error('manualReviewStatus missing');
      if (p.description !== 'Cloud subscription annual - updated description') throw new Error('Payment description corrupted');
    });

    await this.runAssertion('Verify Step 00 baseline tenant survived all 25 migrations', async () => {
      const res = await this.client.select(this.schema, 'tenants', {
        limit: 5,
        where: [{ column: 'id', operator: 'EQ', value: 'tenant_pm_1' }]
      });
      if (res.data?.length !== 1) throw new Error('Baseline tenant not found');
      const t = res.data[0];
      if (t.name !== 'Acme Global Payments Corp') throw new Error(`Tenant name corrupted: ${t.name}`);
      if (t.plan !== 'custom_enterprise_2026') throw new Error(`Tenant plan corrupted: ${t.plan}`);
    });

    await this.runAssertion('Verify Step 00 baseline refund survived all 25 migrations', async () => {
      const res = await this.client.select(this.schema, 'refunds', {
        limit: 5,
        where: [{ column: 'id', operator: 'EQ', value: this.savedIds.refundId }]
      });
      if (res.data?.length !== 1) throw new Error('Baseline refund not found');
    });

    // Aggregate Query Check
    await this.runAssertion('Aggregation test: COUNT and total volume by payment status', async () => {
      const res = await this.client.query({
        type: 'SELECT',
        schema: this.schema,
        limit: 10,
        query: {
          select: ['status', { aggregate: 'COUNT', column: 'id', alias: 'total_count' }],
          from: { resource: 'payments' },
          groupBy: ['status']
        }
      });
      if (!res.data || res.data.length === 0) throw new Error('Aggregation returned no results');
    });

    // Deletion Mutation Check
    await this.runAssertion('DELETE mutation: remove temporary test unverified tenant', async () => {
      const res = await this.client.delete(
        this.schema,
        'tenants',
        { id: { $eq: 'tenant_pm_unverified' } }
      );
      if (res.rowCount !== 1) throw new Error('Tenant delete failed');
    });

    const totalDuration = Date.now() - overallStart;
    const passedCount = this.results.filter(r => r.passed).length;
    const failedCount = this.results.filter(r => !r.passed).length;

    logHeader('TEST SUITE COMPLETED SUCCESSFULLY');
    console.log(`${colors.bold}Total Test Steps:        25 migrations (Steps 00 to 24)${colors.reset}`);
    console.log(`${colors.bold}Total Assertions:        ${this.results.length}${colors.reset}`);
    console.log(`${colors.green}${colors.bold}Assertions Passed:       ${passedCount}${colors.reset}`);
    console.log(`${colors.bold}Assertions Failed:       ${failedCount}${colors.reset}`);
    console.log(`${colors.cyan}${colors.bold}Total Execution Time:    ${(totalDuration / 1000).toFixed(2)}s${colors.reset}\n`);

    return {
      status: 'SUCCESS',
      totalSteps: 25,
      totalAssertions: this.results.length,
      passed: passedCount,
      failed: failedCount,
      durationMs: totalDuration,
      results: this.results
    };
  }
}

// Allow direct CLI invocation: `node src/runner.js`
if (require.main === module) {
  const runner = new TestRunner();
  runner.runAll().catch(err => {
    console.error(`\n${colors.bold}${colors.red}Test run aborted with error:${colors.reset}`, err.message);
    process.exit(1);
  });
}

module.exports = TestRunner;
