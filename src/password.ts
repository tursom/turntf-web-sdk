import bcrypt from "bcryptjs";

export type PasswordSource = "plain" | "hashed";

export interface PasswordInput {
  readonly source: PasswordSource;
  readonly encoded: string;
}

export async function hashPassword(plain: string): Promise<string> {
  if (plain === "") {
    throw new Error("password is required");
  }
  return bcrypt.hash(plain, 10);
}

export async function plainPassword(plain: string): Promise<PasswordInput> {
  return { source: "plain", encoded: await hashPassword(plain) };
}

export function plainPasswordSync(plain: string): PasswordInput {
  if (plain === "") {
    throw new Error("password is required");
  }
  return { source: "plain", encoded: bcrypt.hashSync(plain, 10) };
}

export function hashedPassword(hash: string): PasswordInput {
  return { source: "hashed", encoded: hash };
}

export function validatePassword(password: PasswordInput): void {
  if (password.source !== "plain" && password.source !== "hashed") {
    throw new Error(`invalid password source ${JSON.stringify(password.source)}`);
  }
  if (password.encoded === "") {
    throw new Error("password is required");
  }
}

export function passwordWireValue(password: PasswordInput): string {
  validatePassword(password);
  return password.encoded;
}
