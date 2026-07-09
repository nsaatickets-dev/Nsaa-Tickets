const clerkFrontendApiUrl = process.env.CLERK_FRONTEND_API_URL;

if (!clerkFrontendApiUrl) {
  throw new Error(
    "Missing CLERK_FRONTEND_API_URL. Set it in Convex/your env before running Convex auth.",
  );
}

export default {
  providers: [
    {
      // Found in Clerk's Convex integration setup.
      // Development format: https://verb-noun-00.clerk.accounts.dev
      // Production format: https://clerk.<your-domain>.com
      domain: clerkFrontendApiUrl,
      applicationID: "convex",
    },
  ],
};
