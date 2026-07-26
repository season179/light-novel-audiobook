// The browser and CLI must resolve approval actors identically. Keep this compatibility export at
// the web seam so existing server imports cannot grow a second policy.
export {
  REVIEWER_ENV_VARIABLE,
  resolveReviewerIdentity,
} from '@light-novel-audiobook/application'
