export function publisherDisplayName(publisher) {
  return publisher?.domain ?? publisher?.email ?? publisher?.label ?? (publisher?.fingerprint ? `${publisher.fingerprint.slice(0, 16)}…` : null);
}

export function secureTrustPresentation(context = {}) {
  const signature = context.signature;
  const trust = context.publisherTrust;
  if (signature?.status === 'invalid') {
    return {
      level: 'danger',
      label: 'SIGNATURE INVALID',
      detail: signature.error ?? 'Package integrity could not be verified',
      publisher: null,
      fingerprint: null
    };
  }
  if (signature?.status !== 'signed' || !signature.publisher) {
    return {
      level: 'warning',
      label: 'UNSIGNED WURST',
      detail: 'No publisher identity is attached to this Wurst.',
      publisher: null,
      fingerprint: null
    };
  }

  const publisher = publisherDisplayName(signature.publisher);
  const fingerprint = signature.publisher.fingerprint;
  if (trust?.kind === 'domain' || trust?.kind === 'domain-cached') {
    return {
      level: 'verified',
      label: trust.kind === 'domain' ? 'DOMAIN VERIFIED' : 'DOMAIN VERIFIED BEFORE',
      detail: trust.kind === 'domain' ? `Verified by ${trust.domain.domain} DNS` : `Previously verified for ${trust.domain.domain}`,
      publisher,
      fingerprint
    };
  }
  if (trust?.kind === 'domain-conflict') {
    return {
      level: 'danger',
      label: 'PUBLISHER CONFLICT',
      detail: `${trust.domain.domain} does not authorize this signing key`,
      publisher,
      fingerprint
    };
  }
  if (trust?.kind === 'authority') {
    const certifiedPublisher = publisherDisplayName(trust.certificate?.subject) ?? publisher;
    const claims = Array.isArray(trust.certificate?.claims) ? trust.certificate.claims : [];
    const claimText = claims.map((claim) => `${claim.type}: ${claim.value}`).join(' · ');
    return {
      level: 'verified',
      label: 'VERIFIED PUBLISHER',
      detail: `Verified by ${trust.authority}${claimText ? ` · ${claimText}` : ''}${trust.development ? ' · development authority' : ''}`,
      publisher: certifiedPublisher,
      fingerprint
    };
  }
  if (trust?.kind === 'local') {
    return {
      level: 'verified',
      label: 'TRUSTED SIGNATURE',
      detail: 'This signing key is trusted by this Wurster.',
      publisher,
      fingerprint
    };
  }
  if (trust?.kind === 'revoked-certificate') {
    return {
      level: 'danger',
      label: 'PUBLISHER REVOKED',
      detail: trust.certificate?.status === 'revoked-issuer' ? 'The issuing Authority key is revoked by the local trust bundle.' : 'This publisher key is revoked by the local trust bundle.',
      publisher,
      fingerprint
    };
  }
  if (trust?.kind === 'invalid-certificate') {
    return {
      level: 'danger',
      label: 'CERTIFICATE INVALID',
      detail: trust.certificate?.error ?? 'Publisher certificate verification failed',
      publisher,
      fingerprint
    };
  }
  if (trust?.kind === 'untrusted-authority') {
    return {
      level: 'signed',
      label: 'SIGNED · UNKNOWN AUTHORITY',
      detail: 'The signature is valid, but this Wurster does not trust the certificate authority.',
      publisher,
      fingerprint
    };
  }
  return {
    level: 'signed',
    label: 'SIGNED WURST',
    detail: 'The package signature is valid. The publisher is not independently verified.',
    publisher,
    fingerprint
  };
}

export function verificationTrustRoute(publisherTrust = {}) {
  switch (publisherTrust?.kind) {
    case 'domain': return `Live DNS · ${publisherTrust.domain?.domain ?? 'publisher domain'}`;
    case 'domain-cached': return `Previously verified DNS · ${publisherTrust.domain?.domain ?? 'publisher domain'}`;
    case 'authority': { const claims = Array.isArray(publisherTrust.certificate?.claims) ? publisherTrust.certificate.claims.map((claim) => `${claim.type}:${claim.value}`).join(' + ') : ''; return `WRST.IO Authority${claims ? ` · ${claims}` : ''}`; }
    case 'local': return 'Local Wurster trust store';
    case 'domain-conflict': return `DNS conflict · ${publisherTrust.domain?.domain ?? 'publisher domain'}`;
    case 'revoked-certificate': return 'Revoked by local WRST trust data';
    case 'invalid-certificate': return 'Invalid publisher certificate';
    case 'untrusted-authority': return 'Certificate authority not trusted here';
    case 'signed-unknown': return 'Cryptographic signature only';
    default: return 'No publisher identity';
  }
}
