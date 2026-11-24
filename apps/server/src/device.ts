// What a browser says it is, in its User-Agent, as a person reads it: `Chrome (Mac OS X)`. The
// name a session is given when the sign-in that made it gave none. Undefined for what is no
// browser known here, such as a program.

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  // In this order: each of these says it is Chrome, or Safari, too.
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b/, 'iOS'],
  [/\biPad\b/, 'iPadOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'Chrome OS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'Mac OS X'],
  [/\bLinux\b/, 'Linux'],
];

export function deviceOf(userAgent: string | null | undefined): string | undefined {
  if (userAgent === null || userAgent === undefined) return undefined;
  const browser = BROWSERS.find(([said]) => said.test(userAgent))?.[1];
  if (browser === undefined) return undefined;
  const system = SYSTEMS.find(([said]) => said.test(userAgent))?.[1];
  return system === undefined ? browser : `${browser} (${system})`;
}
