const fallback = "postgres://admin:hunter2@localhost:5432/app";

export const connect = async () => {
  const url = process.env["DATABASE_URL"] ?? fallback;
  return { url };
};
