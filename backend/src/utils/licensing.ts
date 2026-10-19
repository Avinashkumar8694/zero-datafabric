import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import axios from 'axios';

// RSA Public Key — must match the private key used in the Zero Licensing Portal
export const ZERO_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2BKB7U+dlrIQi/FyP370
XlCDvQorh7SwMTwT5s5LoABn5k+FHziUXwfdOdAW2zH4EfAzL4dFcymd8kSZSv2+
sytSdrX+5p/lUYrNuGv2PKATzIHxcOshDcX9H6LDXFJm8P0KCCF7sUpz33fbZese
Dm0Toll5hV4BuqSm6IKcOeGWSJprwd2xRTYWzTqIcITVDRLi65H8vQob9GeylqXE
+74lJTPsvfOmT+CbG+IWGbyONIeSN3jWqfCJKS0C6umZK79OU+STjXHddbfuCt2P
gNDKp45F7y2BYYcKTIpZNTDqOQYv/vvIMCMEERl4kz/AL4CGmymejY3Rg5CCo/Tv
AwIDAQAB
-----END PUBLIC KEY-----`;

// ─── Data Fabric License Payload ─────────────────────────────────────────────
//
// This is the exact object structure the Zero Licensing Portal must embed
// inside the JWT when issuing a "data-fabric" license key.
//
// Field rules:
//   • -1  → unlimited / no restriction enforced
//   • 0   → feature disabled / none allowed
//   • >0  → hard cap at that value

export interface DataFabricLicenseLimits {
  /** Max number of data source connections per tenant */
  max_connections: number;
  /** Max rows ingested / stored per virtual table */
  max_records_per_table: number;
  /** Max virtual tables per tenant */
  max_tables: number;
  /** Max event/webhook triggers per tenant */
  max_triggers: number;
  /** Max replication pipeline source-table mappings */
  max_replication_tables: number;
  /** Max total rows synced across all replication pipelines */
  max_replication_rows: number;
  /** Max rows synced per individual table in a replication job */
  max_replication_rows_per_table: number;
  /** Max concurrent replication pipelines */
  max_replications: number;
  /** Max tenants the license owner can manage */
  max_tenants: number;
  /** API rate limit — requests per minute */
  rate_limit_per_min: number;
  /** API rate limit — requests per hour */
  rate_limit_per_hour: number;
  /** API rate limit — requests per day */
  rate_limit_per_day: number;
  /** API rate limit — requests per month */
  rate_limit_per_month: number;
  /** Data retention / cleanup frequency: 'none' | 'daily' | 'weekly' | 'monthly' */
  data_cleanup_frequency?: string;
  /** Hour of day (0-23, UTC) at which the cleanup job fires */
  data_cleanup_hour?: number;
}

export interface DataFabricLicenseFeatures {
  /** Trial period in days (-1 = never expire; ignored in self-host mode) */
  trial_period_days: number;
  /** Allow custom login page branding (logo, colors, title) */
  custom_branding: boolean;
  /** Allow OIDC/OAuth2 SSO configuration on the login page */
  enterprise_sso_enabled: boolean;
  /** Enable Elasticsearch downstream target connector */
  elasticsearch_enabled: boolean;
  /** Enable Snowflake downstream target connector */
  snowflake_enabled: boolean;
  /** Allow advanced CDC / Kafka replication pipelines */
  cdc_kafka_enabled: boolean;
  /** Allow query engine federation across multiple sources */
  federated_query_enabled: boolean;
  /** Remove "Powered by Zero Data Fabric" branding */
  remove_branding: boolean;
  /**
   * When true, the server will perform encrypted callback validation against
   * the validation_url on startup and every 24 hours.
   * When false (or absent), validation is purely cryptographic — offline/air-gapped safe.
   */
  callback_validation_enabled?: boolean;
}

export interface LicensePayload {
  /** The name of the organization this license is issued to */
  licensee: string;
  /**
   * The product this key is valid for.
   * The Zero Licensing Portal uses the same RSA key across all products.
   * Expected value: "data-fabric" (portal may also issue "identity-server" keys from the same portal).
   */
  product: string;
  /** Human-readable plan/tier name, e.g. "Self-Host Enterprise" */
  name?: string;
  /** ISO-8601 timestamp when the license was issued */
  issuedAt: string;
  /** ISO-8601 timestamp when the license expires */
  expiresAt: string;
  /**
   * When true, the license unlocks self-hosted mode:
   *  - disables plan/subscription UI & enforcement
   *  - enables custom login page editor
   *  - treats all limits set to -1 as unlimited
   */
  selfHosted: boolean;
  /** Hard resource limits enforced by the engine */
  limits: DataFabricLicenseLimits;
  /** Feature flags unlocked by this license */
  features: DataFabricLicenseFeatures;
  /** Max installations this key may be activated on (enforced by portal when callback_validation_enabled=true) */
  max_installations?: number;
  /**
   * URL of the Zero Licensing Portal's validate endpoint.
   * Only used when features.callback_validation_enabled = true.
   * Omit or set callback_validation_enabled=false for offline/air-gapped deployments.
   */
  validation_url?: string;
}

// ─── Cryptographic Verification ──────────────────────────────────────────────

/**
 * Verifies a JWS license token against the embedded RSA public key.
 *
 * Validation steps:
 *  1. JWT signature verified with ZERO_PUBLIC_KEY (RS256)
 *  2. expiresAt must be in the future
 *  3. Warns (but does NOT reject) if product is not "data-fabric" — the Zero Licensing
 *     Portal uses the same RSA key-pair for all Zero products, so a key issued for
 *     any Zero product is cryptographically valid here.
 *
 * Returns the decoded LicensePayload if valid, otherwise null.
 */
export function verifyLicense(licenseKey: string): LicensePayload | null {
  if (!licenseKey || licenseKey.trim() === '') {
    return null;
  }
  try {
    const decoded = jwt.verify(licenseKey.trim(), ZERO_PUBLIC_KEY, {
      algorithms: ['RS256'],
    }) as LicensePayload;

    // Warn if product is not data-fabric (but still accept — shared portal key-pair)
    if (decoded.product && decoded.product !== 'data-fabric') {
      console.warn(
        `[Licensing] ⚠ License key product is "${decoded.product}" (expected "data-fabric"). ` +
        `Accepting — RSA signature is valid. Please regenerate a key with product="data-fabric" when possible.`
      );
    }

    // Guard: expiration check
    if (decoded.expiresAt && new Date() > new Date(decoded.expiresAt)) {
      console.error(`[Licensing] License key expired on ${decoded.expiresAt}`);
      return null;
    }

    return decoded;
  } catch (err: any) {
    console.error('[Licensing] License validation failed:', err.message);
    return null;
  }
}

// ─── Encrypted Callback Validation (mirrors zero-identity-server) ─────────────

/**
 * Encrypts the validation payload exactly as zero-identity-server does:
 *   1. Generate a random AES-256 key + IV
 *   2. Encrypt the JSON payload with AES-256-CBC
 *   3. Encrypt the AES key with the portal's RSA public key (OAEP/SHA-256)
 *
 * The portal decrypts this in POST /api/licenses/validate
 */
function encryptValidationPayload(
  payload: { token: string; instanceId: string; timestamp: number },
  publicKeyPem: string
) {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  let encryptedData = cipher.update(JSON.stringify(payload), 'utf8', 'base64');
  encryptedData += cipher.final('base64');

  const encryptedKey = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  ).toString('base64');

  return { encryptedKey, iv: iv.toString('base64'), encryptedData };
}

// ─── LicenseValidationService ─────────────────────────────────────────────────

export interface LicenseValidationState {
  status: 'valid' | 'grace_period' | 'invalid';
  errorMessage: string | null;
  lastSuccessAt: Date | null;
}

/**
 * Background daemon that mirrors zero-identity-server's LicenseValidationService.
 *
 * Flow on each validation tick:
 *  1. Load the license key (env > settings table)
 *  2. Cryptographically verify it with ZERO_PUBLIC_KEY
 *  3. If features.callback_validation_enabled = false (or no validation_url) → mark valid, skip HTTP call
 *  4. If callback enabled: send encrypted payload to validation_url, verify signed response
 *  5. On network failure: apply 60-day grace period before locking
 *
 * Usage:
 *   const svc = new LicenseValidationService();
 *   await svc.start(instanceId, getLicenseKey);
 */
export class LicenseValidationService {
  private intervalId: NodeJS.Timeout | undefined = undefined;
  public state: LicenseValidationState = {
    status: 'valid',
    errorMessage: null,
    lastSuccessAt: null,
  };

  // Persists state to DB after every tick — injected from index.ts (mirrors IDS SystemSettings save)
  private onStatusChange: ((
    status: string,
    errorMessage: string | null,
    lastSuccessAt: Date | null
  ) => Promise<void>) | undefined = undefined;

  /**
   * Start the daemon. Runs immediately on startup (awaited), then every 24 hours.
   * Mirrors IDS: validationService.start() is called BEFORE app.listen().
   *
   * @param instanceId     Unique stable ID for this server instance (persisted in DB)
   * @param getLicenseKey  Async fn that returns the current raw JWT license key string
   * @param onStatusChange Optional callback to persist validation state to DB after each tick
   */
  async start(
    instanceId: string,
    getLicenseKey: () => Promise<string>,
    onStatusChange?: (status: string, errorMessage: string | null, lastSuccessAt: Date | null) => Promise<void>
  ): Promise<void> {
    this.onStatusChange = onStatusChange;
    console.log('[Licensing Daemon] Starting validation daemon...');
    console.log(`[Licensing Daemon] Server instance_id: ${instanceId}`);

    await this.validate(instanceId, getLicenseKey);

    const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
    this.intervalId = setInterval(() => {
      this.validate(instanceId, getLicenseKey).catch((err) => {
        console.error('[Licensing Daemon] Scheduled check error:', err);
      });
    }, INTERVAL_MS);
    this.intervalId.unref();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  // ── Internal: set state + persist to DB via onStatusChange ──────────────────
  private async setState(
    status: 'valid' | 'grace_period' | 'invalid',
    errorMessage: string | null,
    lastSuccessAt: Date | null
  ): Promise<void> {
    this.state = { status, errorMessage, lastSuccessAt };
    if (this.onStatusChange) {
      await this.onStatusChange(status, errorMessage, lastSuccessAt).catch(() => {});
    }
  }

  /**
   * Single validation tick — mirrors zero-identity-server's LicenseValidationService.validate().
   *
   * Flow:
   *  1. Get license key (env → DB)
   *  2. Cryptographic RS256 verification
   *  3. If callback_validation_enabled=false or no validation_url → purely cryptographic, mark valid
   *  4. Encrypt { token, instanceId, timestamp } with AES-256-CBC + RSA-OAEP and POST to portal
   *  5. Verify portal response RSA signature + instanceId + timestamp freshness
   *  6. On network failure: 60-day grace period from last_successful_validation_at
   *  7. All state changes persisted to DB via onStatusChange callback
   */
  async validate(instanceId: string, getLicenseKey: () => Promise<string>): Promise<void> {
    console.log('[Licensing Daemon] Initiating validation check...');
    try {
      const token = (await getLicenseKey()).trim();

      // 1. No key at all — fall through to trial/subscription mode (not an error)
      if (!token) {
        console.warn('[Licensing Daemon] No license key installed. Running in trial/subscription mode.');
        await this.setState('valid', null, this.state.lastSuccessAt);
        return;
      }

      // 2. Cryptographic verification (RS256 against hardcoded ZERO_PUBLIC_KEY)
      const activeLicense = verifyLicense(token);
      if (!activeLicense) {
        console.warn('[Licensing Daemon] License key is cryptographically invalid or expired.');
        await this.setState(
          'invalid',
          'License key is cryptographically invalid or has expired.',
          this.state.lastSuccessAt
        );
        return;
      }

      // 3. Check if callback validation is enabled in the license features
      const callbackEnabled = activeLicense.features?.callback_validation_enabled !== false;
      const validationUrl = activeLicense.validation_url;

      if (!callbackEnabled || !validationUrl) {
        console.log('[Licensing Daemon] Callback validation disabled — purely cryptographic mode.');
        await this.setState('valid', null, new Date());
        return;
      }

      // 4. Encrypted callback to validation portal
      const rawPayload = { token, instanceId, timestamp: Date.now() };
      const encrypted = encryptValidationPayload(rawPayload, ZERO_PUBLIC_KEY);
      console.log(`[Licensing Daemon] Sending validate request to: ${validationUrl} (instanceId: ${instanceId})`);

      try {
        const response = await axios.post(
          validationUrl,
          { payload: encrypted },
          { timeout: 10000 }
        );

        if (response.status === 200 && response.data) {
          const { data: responseData, signature } = response.data;

          if (!responseData || !signature) {
            throw new Error('Validation response signature is missing. Potential MITM interception detected!');
          }

          // 5a. Verify the portal's RSA signature on the response body
          const verify = crypto.createVerify('SHA256');
          verify.update(JSON.stringify(responseData));
          const isSignatureValid = verify.verify(ZERO_PUBLIC_KEY, signature, 'base64');
          if (!isSignatureValid) {
            throw new Error('Invalid response signature. Response may have been spoofed!');
          }

          // 5b. Verify instance ID (replay attack protection)
          if (responseData.instanceId !== instanceId) {
            throw new Error('Instance ID mismatch in validation response. Replay attack detected.');
          }

          // 5c. Verify timestamp freshness (within 5 minutes)
          if (Math.abs(Date.now() - responseData.timestamp) > 5 * 60 * 1000) {
            throw new Error('Validation signature timestamp is stale. Replay attack detected.');
          }

          if (responseData.valid === true) {
            console.log('\x1b[32m[Licensing Daemon] ✔ Callback validation SUCCESS (Signed and Verified).\x1b[0m');
            await this.setState('valid', null, new Date());
          } else {
            const reason = responseData.reason || 'License validation rejected by portal.';
            console.error(`[Licensing Daemon] Explicit validation rejection: ${reason}`);
            await this.setState('invalid', reason, this.state.lastSuccessAt);
          }
        } else {
          throw new Error(`Unexpected portal response code: ${response.status}`);
        }

      } catch (err: any) {
        // 6. Network error / portal offline — apply 60-day grace period (mirrors IDS exactly)
        console.warn(`[Licensing Daemon] Callback request failed: ${err.message}`);

        const baseDate = this.state.lastSuccessAt
          ? this.state.lastSuccessAt
          : new Date(activeLicense.issuedAt || Date.now());
        const diffDays = Math.ceil(Math.abs(Date.now() - baseDate.getTime()) / (1000 * 60 * 60 * 24));
        console.warn(`[Licensing Daemon] Days since last successful validation: ${diffDays}`);

        if (diffDays > 60) {
          console.error('[Licensing Daemon] 60-day grace period exceeded. Marking license invalid.');
          await this.setState(
            'invalid',
            'License validation has failed for more than 60 days. Please verify server internet connectivity or contact support.',
            this.state.lastSuccessAt
          );
        } else {
          await this.setState(
            'grace_period',
            `Connection to licensing portal failed. Service will be blocked in ${60 - diffDays} day(s) if validation does not succeed.`,
            this.state.lastSuccessAt
          );
        }
      }

    } catch (error: any) {
      console.error('[Licensing Daemon] Error running validate task:', error);
    }
  }
}
