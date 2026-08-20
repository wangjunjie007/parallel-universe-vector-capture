export interface AssetIntegrityResult {
  ok: boolean;
  bytes: number;
  sha256?: string;
  expected?: string;
  error?: string;
}

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export async function sha256Blob(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  return toHex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
}

export async function verifyAsset(url: string, expected?: string): Promise<AssetIntegrityResult> {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) return { ok: false, bytes: 0, expected, error: `HTTP ${response.status}` };
    const blob = await response.blob();
    const sha256 = await sha256Blob(blob);
    return {
      ok: !expected || sha256 === expected,
      bytes: blob.size,
      sha256,
      expected,
      error: expected && sha256 !== expected ? 'SHA-256 mismatch' : undefined,
    };
  } catch (error) {
    return { ok: false, bytes: 0, expected, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchVerifiedBytes(url: string, expected?: string): Promise<{ bytes: Uint8Array; sha256: string }> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Asset request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = toHex(await crypto.subtle.digest('SHA-256', bytes));
  if (expected && expected !== sha256) throw new Error(`Asset SHA-256 mismatch for ${url}`);
  return { bytes, sha256 };
}
