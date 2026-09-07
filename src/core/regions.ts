/**
 * Where CALL-E can place a call, and in what language.
 *
 * Transcribed from the supported-regions table in CALL-E's integrations
 * repository on 2026-09-07. It exists so an unsupported number is refused
 * locally, with the list of what would work, instead of costing a round trip
 * to be told the same thing less helpfully.
 *
 * The provider is the authority. When this list and the API disagree, the API
 * is right and this file is stale — it is a courtesy check, not a gate.
 */

export interface SupportedRegion {
  readonly country: string;
  /** ISO 3166-1 alpha-2, as the API expects in `recipient.region`. */
  readonly code: string;
  /** E.164 calling prefix, including the plus. */
  readonly dialing: string;
  readonly languages: readonly string[];
  /** `Local` lines originate in-country; `International` route in. */
  readonly line: "Local" | "International";
}

export const SUPPORTED_REGIONS: readonly SupportedRegion[] = [
  { country: "United States of America", code: "US", dialing: "+1", languages: ["English"], line: "Local" },
  { country: "Singapore", code: "SG", dialing: "+65", languages: ["English"], line: "Local" },
  { country: "Malaysia", code: "MY", dialing: "+60", languages: ["English", "Chinese", "Malay"], line: "Local" },
  { country: "India", code: "IN", dialing: "+91", languages: ["English", "Hindi", "Tamil"], line: "International" },
  { country: "United Arab Emirates", code: "AE", dialing: "+971", languages: ["English", "Arabic"], line: "Local" },
  { country: "Australia", code: "AU", dialing: "+61", languages: ["English"], line: "Local" },
  { country: "Canada", code: "CA", dialing: "+1", languages: ["English"], line: "International" },
  { country: "United Kingdom of Great Britain and Northern Ireland", code: "GB", dialing: "+44", languages: ["English"], line: "International" },
  { country: "Viet Nam", code: "VN", dialing: "+84", languages: ["Vietnamese", "English"], line: "International" },
  { country: "Germany", code: "DE", dialing: "+49", languages: ["English", "German"], line: "International" },
  { country: "Japan", code: "JP", dialing: "+81", languages: ["Japanese", "English"], line: "International" },
  { country: "France", code: "FR", dialing: "+33", languages: ["French", "English"], line: "International" },
  { country: "Mexico", code: "MX", dialing: "+52", languages: ["Spanish", "English"], line: "Local" },
  { country: "Brazil", code: "BR", dialing: "+55", languages: ["Portuguese", "English"], line: "Local" },
  { country: "Indonesia", code: "ID", dialing: "+62", languages: ["English"], line: "International" },
  { country: "Philippines", code: "PH", dialing: "+63", languages: ["English"], line: "International" },
  { country: "Kenya", code: "KE", dialing: "+254", languages: ["English"], line: "International" },
  { country: "Netherlands", code: "NL", dialing: "+31", languages: ["English"], line: "International" },
  { country: "Poland", code: "PL", dialing: "+48", languages: ["Polish", "English"], line: "International" },
  { country: "Bangladesh", code: "BD", dialing: "+880", languages: ["Bengali", "English"], line: "International" },
  { country: "Nigeria", code: "NG", dialing: "+234", languages: ["English"], line: "International" },
  { country: "Oman", code: "OM", dialing: "+968", languages: ["English", "Arabic"], line: "International" },
  { country: "Thailand", code: "TH", dialing: "+66", languages: ["English", "Thai"], line: "International" },
  { country: "Namibia", code: "NA", dialing: "+264", languages: ["English"], line: "International" },
  { country: "Cameroon", code: "CM", dialing: "+237", languages: ["English", "French"], line: "International" },
  { country: "Mozambique", code: "MZ", dialing: "+258", languages: ["English", "Portuguese"], line: "International" },
  { country: "Saudi Arabia", code: "SA", dialing: "+966", languages: ["English", "Arabic"], line: "International" },
  { country: "Finland", code: "FI", dialing: "+358", languages: ["English", "Finnish"], line: "International" },
  { country: "Ukraine", code: "UA", dialing: "+380", languages: ["English", "Ukrainian"], line: "International" },
  { country: "Sri Lanka", code: "LK", dialing: "+94", languages: ["English", "Tamil", "Sinhala"], line: "International" },
  { country: "Botswana", code: "BW", dialing: "+267", languages: ["English"], line: "International" },
  { country: "Pakistan", code: "PK", dialing: "+92", languages: ["English", "Urdu"], line: "International" },
  { country: "Turkey", code: "TR", dialing: "+90", languages: ["Turkish"], line: "International" },
  { country: "Honduras", code: "HN", dialing: "+504", languages: ["English", "Spanish"], line: "International" },
  { country: "Spain", code: "ES", dialing: "+34", languages: ["English", "Spanish"], line: "International" },
  { country: "Taiwan", code: "TW", dialing: "+886", languages: ["English"], line: "International" },
  { country: "South Africa", code: "ZA", dialing: "+27", languages: ["English"], line: "International" },
  { country: "Egypt", code: "EG", dialing: "+20", languages: ["English", "Arabic"], line: "International" },
  { country: "Ghana", code: "GH", dialing: "+233", languages: ["English"], line: "International" },
  { country: "Israel", code: "IL", dialing: "+972", languages: ["English", "Hebrew"], line: "International" },
  { country: "Ireland", code: "IE", dialing: "+353", languages: ["English"], line: "International" },
  { country: "Tunisia", code: "TN", dialing: "+216", languages: ["English"], line: "International" },
];

/**
 * The region whose dialing prefix matches this number, longest prefix first
 * so `+1` does not shadow a longer code that starts with it.
 */
export function regionForNumber(e164: string): SupportedRegion | null {
  const byLength = [...SUPPORTED_REGIONS].sort((a, b) => b.dialing.length - a.dialing.length);
  return byLength.find((region) => e164.startsWith(region.dialing)) ?? null;
}

/** Regions that can be called in a given language, for an error message. */
export function regionsSpeaking(language: string): readonly SupportedRegion[] {
  const wanted = language.toLowerCase();
  return SUPPORTED_REGIONS.filter((region) =>
    region.languages.some((l) => l.toLowerCase() === wanted),
  );
}
