import jwt from 'jsonwebtoken';

// Hardcoded RSA Public Key matched to the Licensing Portal Private Key
export const ZERO_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2BKB7U+dlrIQi/FyP370
XlCDvQorh7SwMTwT5s5LoABn5k+FHziUXwfdOdAW2zH4EfAzL4dFcymd8kSZSv2+
sytSdrX+5p/lUYrNuGv2PKATzIHxcOshDcX9H6LDXFJm8P0KCCF7sUpz33fbZese
Dm0Toll5hV4BuqSm6IKcOeGWSJprwd2xRTYWzTqIcITVDRLi65H8vQob9GeylqXE
+74lJTPsvfOmT+CbG+IWGbyONIeSN3jWqfCJKS0C6umZK79OU+STjXHddbfuCt2P
gNDKp45F7y2BYYcKTIpZNTDqOQYv/vvIMCMEERl4kz/AL4CGmymejY3Rg5CCo/Tv
AwIDAQAB
-----END PUBLIC KEY-----`;

// Default seeded B2B selfhost license key
export const DEFAULT_LICENSE_KEY = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJsaWNlbnNlZSI6Ik9yZ2FuaXphdGlvbiBBIiwibmFtZSI6IkIyQi1GYWJyaXhseS1JRFMiLCJpc3N1ZWRBdCI6IjIwMjYtMDctMTJUMDk6NDA6MDAuMDAwWiIsImV4cGlyZXNBdCI6IjIwMzEtMTItMTJUMDk6NDA6MDAuMDAwWiIsInNlbGZIb3N0ZWQiOnRydWUsInByb2R1Y3QiOiJpZGVudGl0eS1zZXJ2ZXIiLCJsaW1pdHMiOnsibWF1Ijo1MDAsIm1heF9vcmdhbml6YXRpb25zIjo1LCJtYXhfY2xpZW50cyI6MjAsIm1heF9yb2xlcyI6NTAsImRhdGFfcmV0ZW50aW9uX2RheXMiOjcsIm0ybV90b2tlbl9saW1pdCI6MjAwMH0sImZlYXR1cmVzIjp7InBhc3N3b3JkbGVzc19lbmFibGVkIjp0cnVlLCJtYWdpY19saW5rX2VuYWJsZWQiOnRydWUsIm9tb2JpbGVfYXV0aF9lbmFibGVkIjp0cnVlLCJzb2NpYWxfbG9naW4vZW5hYmxlZCI6dHJ1ZSwic29jaWFsX2xvZ2luIjp0cnVlLCJlbnRlcnByaXNlX3Nzb19lbmFibGVkIjp0cnVlLCJjdXN0b21fZG9tYWluX2VuYWJsZWQiOnRydWUsInJlbW92ZV9icmFuZGluZyI6dHJ1ZSwiY3VzdG9tX2JyYW5kaW5nIjp0cnVlLCJjdXN0b21fZW1haWxfdGVtcGxhdGVzIjp0cnVlLCJhZHZhbmNlZF9jc3MiOnRydWUsIm1mYV9lbmFibGVkIjp0cnVlLCJtZmFfZW5mb3JjZWQiOnRydWUsImF1ZGl0X2xvZ3NfZW5hYmxlZCI6dHJ1ZSwibTJtX2VuYWJsZWQiOnRydWUsImNhbGxiYWNrX3ZhbGlkYXRpb25fZW5hYmxlZCI6dHJ1ZSwiYWxsb3dlZF9zb2NpYWxfcHJvdmlkZXJzIjpbIioiLCJnb29nbGUiLCJnaXRodWIiLCJmYWNlYm9vayIsIm1pY3Jvc29mdCIsImFwcGxlIiwia2V5Y2xvYWsiXSwiYWxsb3dlZF9tZmFfbWV0aG9kcyI6WyIqIiwidG90cCIsInBhc3NrZXkiLCJzbXMtb3RwIiwiZW1haWwtb3RwIiwiYmFja3VwLWNvZGUiXX0sIm1heF9pbnN0YWxsYXRpb25zIjoxLCJ2YWxpZGF0aW9uX3VybCI6Imh0dHA6Ly9sb2NhbGhvc3Q6MzAwNS9hcGkvbGljZW5zZXMvdmFsaWRhdGUiLCJpYXQiOjE3ODM4NDkzNjR9.X4O_dVbnVJmAHW2vvcs7VEX9pkASVoIbGScI_umtdYUljyeLt18IlSzaqyqjGWhNBqw7cc7fmRa_3blg4EV3ttn9ZPcISPPUDpHInPOY8tkQF8hjrEg9WaO95gmBtkhdRbPNGeORgrj0Ptynx_HhlWaIWrpbVD95FhQDlPL8nQE5DZPrTTzcluBxDhEOe5RcT6tlkSbZzJuwXoedDxj2iVVzxu3hp7OnFc7r-2qrlBXjx9TIXdtUB8khem61y2p7Z3A_ys96Gxnn35d8j90Ns70C1iu1avalUNGNYiZH1mI3j7BrV_kDsWsikW5g8z9dOqm7sD4hXbqHJHo5yxFdJQ";

export interface LicensePayload {
    licensee: string;
    expiresAt: string;
    selfHosted: boolean;
    limits: any;
    features: any;
}

/**
 * Verifies a JWS license token against the embedded RSA public key.
 * Returns the decoded payload if valid, otherwise returns null.
 */
export function verifyLicense(licenseKey: string): LicensePayload | null {
    if (!licenseKey || licenseKey.trim() === "") {
        return null;
    }
    try {
        const decoded = jwt.verify(licenseKey.trim(), ZERO_PUBLIC_KEY, {
            algorithms: ["RS256"]
        }) as LicensePayload;

        // Verify Expiration date
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
