export default {
  providers: [
    {
      // Replace with your real Clerk Frontend API URL, found in the
      // Clerk dashboard under "API Keys" -> "Frontend API URL".
      // Example: https://your-app-name.clerk.accounts.dev
      domain:
        process.env.CLERK_FRONTEND_API_URL ??
        "https://REPLACE_ME.clerk.accounts.dev",
      applicationID: "convex",
    },
  ],
};
