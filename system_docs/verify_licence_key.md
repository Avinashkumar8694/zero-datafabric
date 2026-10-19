import jwt from 'jsonwebtoken';

export const ZERO_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2BKB7U+dlrIQi/FyP370
XlCDvQorh7SwMTwT5s5LoABn5k+FHziUXwfdOdAW2zH4EfAzL4dFcymd8kSZSv2+
sytSdrX+5p/lUYrNuGv2PKATzIHxcOshDcX9H6LDXFJm8P0KCCF7sUpz33fbZese
Dm0Toll5hV4BuqSm6IKcOeGWSJprwd2xRTYWzTqIcITVDRLi65H8vQob9GeylqXE
+74lJTPsvfOmT+CbG+IWGbyONIeSN3jWqfCJKS0C6umZK79OU+STjXHddbfuCt2P
gNDKp45F7y2BYYcKTIpZNTDqOQYv/vvIMCMEERl4kz/AL4CGmymejY3Rg5CCo/Tv
AwIDAQAB
-----END PUBLIC KEY-----`;

export function verifyLicense(licenseKey: string): LicensePayload | null {
    try {
        const decoded = jwt.verify(licenseKey.trim(), ZERO_PUBLIC_KEY, {
            algorithms: ["RS256"]
        }) as LicensePayload;

        if (decoded.expiresAt && new Date() > new Date(decoded.expiresAt)) {
            console.error(`[Licensing] License key expired on ${decoded.expiresAt}`);
            return null;
        }
        return decoded;
    } catch (err: any) {
        console.error("[Licensing] License validation failed:", err.message);
        return null;
    }
}

<!-- sample -->
{
  "licensee": "Your Org Name",
  "product": "data-fabric",
  "name": "Self-Host Enterprise",
  "issuedAt": "2026-07-15T00:00:00.000Z",
  "expiresAt": "2031-07-15T00:00:00.000Z",
  "selfHosted": true,

  "limits": {
    "max_connections": -1,
    "max_records_per_table": -1,
    "max_tables": -1,
    "max_triggers": -1,
    "max_replication_tables": -1,
    "max_replication_rows": -1,
    "max_replication_rows_per_table": -1,
    "max_replications": -1,
    "max_tenants": -1,
    "rate_limit_per_min": -1,
    "rate_limit_per_hour": -1,
    "rate_limit_per_day": -1,
    "rate_limit_per_month": -1,
    "data_cleanup_frequency": "weekly",
    "data_cleanup_hour": 2
  },

  "features": {
    "trial_period_days": -1,
    "custom_branding": true,
    "enterprise_sso_enabled": true,
    "elasticsearch_enabled": true,
    "snowflake_enabled": true,
    "cdc_kafka_enabled": true,
    "federated_query_enabled": true,
    "remove_branding": true,
    "callback_validation_enabled": true
  },

  "max_installations": 1,
  "validation_url": "https://licensing.fabrixly.com/api/licenses/validate"
}