// The database tests always run, so a missing URL is an error rather than a
// reason to skip them: a CI job without Postgres must fail, not pass empty.
// The value is never echoed because it carries the database password.
export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is required: the api tests run against a real Postgres. See apps/api/README.md.",
    );
  }
  if (!URL.canParse(url)) {
    throw new Error("TEST_DATABASE_URL is not a valid URL");
  }
  return url;
}
