// Generated from the private Wurster Lab operator realm. Public trust material only.
export const TRUSTED_AUTHORITIES = [
  {
    "format": "wurst/authority-root-1",
    "authority": "wrst.io",
    "algorithm": "ed25519",
    "name": "WRST.IO Root Authority",
    "fingerprint": "5ed4c12bd45ab66d44da809182a140cabce20f44d5e7e20464adc0e7147f3914",
    "publicKeySpki": "MCowBQYDK2VwAyEAhg+OCoDjNYtcF0CQRKhjXnyYWB2r+yZXBG0/roLxWl0=",
    "createdAt": "2026-08-12T11:44:16.580Z"
  }
];
export const TRUST_BUNDLE = {
  "format": "wurst/trust-bundle-1",
  "algorithm": "ed25519",
  "statement": {
    "format": "wurst/trust-bundle-statement-1",
    "authority": "wrst.io",
    "version": 1,
    "generatedAt": "2026-08-12T11:44:16.580Z",
    "root": {
      "format": "wurst/authority-root-1",
      "authority": "wrst.io",
      "algorithm": "ed25519",
      "name": "WRST.IO Root Authority",
      "fingerprint": "5ed4c12bd45ab66d44da809182a140cabce20f44d5e7e20464adc0e7147f3914",
      "publicKeySpki": "MCowBQYDK2VwAyEAhg+OCoDjNYtcF0CQRKhjXnyYWB2r+yZXBG0/roLxWl0=",
      "createdAt": "2026-08-12T11:44:16.580Z"
    },
    "issuers": [
      {
        "format": "wurst/authority-issuer-certificate-1",
        "algorithm": "ed25519",
        "statement": {
          "format": "wurst/authority-issuer-certificate-statement-1",
          "serial": "25621c13-7901-4859-9ab7-c439537948a8",
          "authority": "wrst.io",
          "root": {
            "format": "wurst/authority-root-1",
            "authority": "wrst.io",
            "algorithm": "ed25519",
            "name": "WRST.IO Root Authority",
            "fingerprint": "5ed4c12bd45ab66d44da809182a140cabce20f44d5e7e20464adc0e7147f3914",
            "publicKeySpki": "MCowBQYDK2VwAyEAhg+OCoDjNYtcF0CQRKhjXnyYWB2r+yZXBG0/roLxWl0=",
            "createdAt": "2026-08-12T11:44:16.580Z"
          },
          "issuer": {
            "format": "wurst/authority-issuer-public-1",
            "authority": "wrst.io",
            "issuerId": "wrst.io-issuer-2026-01",
            "algorithm": "ed25519",
            "name": "WRST.IO Issuing Authority 2026",
            "fingerprint": "5f4c76341896e48dc3cc515f4cf92fc8547156b57c3f2adbb9909516d8e67211",
            "publicKeySpki": "MCowBQYDK2VwAyEAKOj712obnE1N6DX9W3HQmjQj0V3oKsq7gq1GMItOU+k="
          },
          "issuedAt": "2026-08-12T11:44:16.580Z",
          "expiresAt": "2031-08-11T11:44:16.680Z"
        },
        "signature": "DmKcfu+7I/uBfaXOzBK4a9ftowKUewf9bAIgIgOR3u29Mnp8xZGzpwoupv/P6uA0WuMPgkwGeu6CKxFwDiSKAQ=="
      }
    ],
    "revokedIssuers": [],
    "revokedPublishers": []
  },
  "signature": "EH1lfBmFfNiheBWq3vMGxhJzwmZ68YG42laI1kd2Fu22kwxJZFK5q1aSq/KShN59R4LVFy+KDNr/jeFkkKzCDA=="
};
