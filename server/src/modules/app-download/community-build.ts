/**
 * Where the Community Android build is published. Forks change these two values and nothing else:
 * the download page, the `/download/linekeep.apk` redirect and the admin Config page all derive from them.
 */
export const COMMUNITY_APK_REPO = "shubhsherl/linekeep";
/** The release asset the redirect points at; it must exist on every release of the repository. */
export const COMMUNITY_APK_ASSET = "linekeep.apk";

export const communityReleasesUrl = `https://github.com/${COMMUNITY_APK_REPO}/releases/latest`;
export const communityApkUrl = `${communityReleasesUrl}/download/${COMMUNITY_APK_ASSET}`;
