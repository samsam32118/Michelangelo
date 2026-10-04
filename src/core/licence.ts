/**
 * Licence rules for open media (media.search / media.fetch / media.credits and the stock QA checks). Pure.
 *
 * Every source maps its own licence strings to a canonical id ("cc0", "pdm", "pd-us-gov", "cc-by-4.0",
 * "cc-by-sa-3.0", "cc-by-nc-4.0", ..., "nkr" (an archive's "no known copyright restrictions"), or a platform licence such as
 * "pexels") and core decides what may be used.
 * Unknown licences are refused (fail closed).
 */

export const LICENCE_CLASSES = ['free', 'attribution', 'share-alike', 'non-commercial', 'no-derivatives', 'unknown'] as const;
export type LicenceClass = (typeof LICENCE_CLASSES)[number];

/** Platform licences that allow commercial use and changes without attribution. */
const PLATFORM_FREE = new Set(['pexels', 'pixabay', 'unsplash']);

/** The class of a canonical licence id. */
export function licenceClass(id: string | undefined): LicenceClass {
  const s = (id ?? '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (s === 'cc0' || s === 'pdm' || s.startsWith('pd-') || s === 'public-domain' || s === 'nkr' || PLATFORM_FREE.has(s)) return 'free';
  if (!/^cc-by(-|$)/.test(s)) return 'unknown';
  if (/-nd(-|$)/.test(s)) return 'no-derivatives';
  if (/-nc(-|$)/.test(s)) return 'non-commercial';
  if (/-sa(-|$)/.test(s)) return 'share-alike';
  return 'attribution';
}

/** Classes used by default: free to use, or free with credit. */
export const DEFAULT_ALLOWED: LicenceClass[] = ['free', 'attribution'];

/** Why a class is refused, and how to allow it (undefined when allowed). ND and unknown are never allowed: an edit is a derivative. */
export function refusal(cls: LicenceClass, allowed: readonly string[]): string | undefined {
  if (cls === 'no-derivatives') return 'no-derivatives licences forbid edits, and every use in a video is an edit';
  if (cls === 'unknown') return 'the licence could not be identified (refused to be safe)';
  if (allowed.includes(cls)) return undefined;
  if (cls === 'share-alike') return 'share-alike: the whole video would have to be released under the same licence (allow with licences=["share-alike"])';
  if (cls === 'non-commercial') return 'non-commercial only (allow with licences=["non-commercial"] for a non-commercial video)';
  return `licence class ${cls} is not allowed`;
}

/**
 * A canonical id from a Creative Commons licence URL or a short name ("by-sa", "CC BY 4.0", "cc0", "pdm").
 * Returns undefined when it is not a recognisable CC / public-domain licence.
 */
export function canonicalLicence(raw: string | undefined, version?: string): string | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase().trim();
  if (/publicdomain\/zero|(^|\W)cc0(\W|$)|^cc-?zero/.test(s)) return 'cc0';
  if (/publicdomain\/mark|^pdm$|public domain mark/.test(s)) return 'pdm';
  if (/creativecommons\.org\/licenses\/publicdomain/.test(s)) return 'pdm';
  const url = /creativecommons\.org\/licenses\/([a-z-]+)\/(\d(?:\.\d)?)/.exec(s);
  const name = url ? url[1]! : (/^(?:cc[\s-]*)?(by(?:[\s-]+(?:nc|nd|sa)){0,2})(?:[\s-]+(\d(?:\.\d)?))?$/.exec(s)?.[1] ?? '').replace(/\s+/g, '-');
  if (!name || !/^by(-(nc|nd|sa))*$/.test(name)) return undefined;
  const ver = url?.[2] ?? /(\d\.\d)/.exec(s)?.[1] ?? version;
  return `cc-${name}${ver ? `-${ver}` : ''}`;
}

/** The licence's display name: "CC BY 4.0", "CC0", "Public Domain Mark", "Pexels licence". */
export function licenceName(id: string): string {
  const s = id.toLowerCase();
  if (s === 'cc0') return 'CC0';
  if (s === 'pdm') return 'Public Domain Mark';
  if (s === 'pd-us-gov') return 'public domain (US government work)';
  if (s === 'nkr') return 'no known copyright restrictions';
  if (s.startsWith('pd-') || s === 'public-domain') return 'public domain';
  if (PLATFORM_FREE.has(s)) return `${s[0]!.toUpperCase()}${s.slice(1)} licence`;
  const m = /^cc-([a-z-]+?)(?:-(\d\.\d|\d))?$/.exec(s);
  return m ? `CC ${m[1]!.toUpperCase().replace(/-/g, '-')}${m[2] ? ` ${m[2]}` : ''}` : id;
}

/** A canonical licence URL for CC ids when the source gave none. */
export function licenceUrl(id: string): string | undefined {
  const s = id.toLowerCase();
  if (s === 'cc0') return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (s === 'pdm') return 'https://creativecommons.org/publicdomain/mark/1.0/';
  const m = /^cc-(by(?:-(?:nc|nd|sa))*)-(\d\.\d|\d)$/.exec(s);
  return m ? `https://creativecommons.org/licenses/${m[1]}/${m[2]!.includes('.') ? m[2] : `${m[2]}.0`}/` : undefined;
}

/** One attribution line (title, author, source, licence): "“Deep Whoosh #1” by bigdog (Freesound), CC BY 4.0". */
export function creditLine(it: { title: string; author?: string | undefined; source: string; licence: { id: string } }): string {
  const title = it.title.trim() ? `“${it.title.trim()}”` : 'Untitled';
  return `${title}${it.author ? ` by ${it.author}` : ''} (${it.source}), ${licenceName(it.licence.id)}`;
}
