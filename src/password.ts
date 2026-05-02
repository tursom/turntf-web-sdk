import bcrypt from "bcryptjs";

/**
 * 密码来源类型。
 * - "plain": 原始密码，将由 SDK 自动进行 bcrypt 哈希处理
 * - "hashed": 已哈希的密码，SDK 将直接使用
 */
export type PasswordSource = "plain" | "hashed";

/**
 * 密码输入参数。
 * 用于向认证接口传递密码信息，包含密码来源和编码后的密码值。
 * 使用 {@link plainPassword}、{@link plainPasswordSync} 或 {@link hashedPassword} 工厂方法创建。
 */
export interface PasswordInput {
  /** 密码来源类型，标记密码是原始明文还是已哈希的 */
  readonly source: PasswordSource;
  /** 编码后的密码值（bcrypt 哈希值） */
  readonly encoded: string;
}

/**
 * 使用 bcrypt 算法异步哈希密码。
 * @param plain - 原始密码字符串，不能为空
 * @returns bcrypt 哈希后的密码字符串
 * @throws 如果密码为空字符串则抛出错误
 */
export async function hashPassword(plain: string): Promise<string> {
  if (plain === "") {
    throw new Error("password is required");
  }
  return bcrypt.hash(plain, 10);
}

/**
 * 创建原始密码的 PasswordInput（异步方式）。
 * 自动对密码进行 bcrypt 哈希处理，并将 source 设置为 "plain"。
 *
 * @param plain - 原始密码字符串
 * @returns 包含密码来源和哈希值的 PasswordInput 对象
 * @throws 如果密码为空字符串则抛出错误
 *
 * @example
 * const input = await plainPassword("mySecurePassword");
 */
export async function plainPassword(plain: string): Promise<PasswordInput> {
  return { source: "plain", encoded: await hashPassword(plain) };
}

/**
 * 创建原始密码的 PasswordInput（同步方式）。
 * 使用同步的 bcrypt 哈希处理，适用于无法使用 async/await 的场景。
 *
 * @param plain - 原始密码字符串
 * @returns 包含密码来源和哈希值的 PasswordInput 对象
 * @throws 如果密码为空字符串则抛出错误
 *
 * @example
 * const input = plainPasswordSync("mySecurePassword");
 */
export function plainPasswordSync(plain: string): PasswordInput {
  if (plain === "") {
    throw new Error("password is required");
  }
  return { source: "plain", encoded: bcrypt.hashSync(plain, 10) };
}

/**
 * 使用已有的 bcrypt 哈希值创建 PasswordInput。
 * 适用于密码已在服务端或其他系统中完成哈希处理的场景。
 *
 * @param hash - 已有的 bcrypt 哈希值
 * @returns 包含密码来源和哈希值的 PasswordInput 对象，source 设置为 "hashed"
 *
 * @example
 * const input = hashedPassword("$2a$10$...");
 */
export function hashedPassword(hash: string): PasswordInput {
  return { source: "hashed", encoded: hash };
}

/**
 * 验证 PasswordInput 对象的合法性。
 * 检查 source 是否为 "plain" 或 "hashed"，且 encoded 不为空。
 *
 * @param password - 待验证的密码输入对象
 * @throws 如果密码来源无效或编码值为空则抛出错误
 */
export function validatePassword(password: PasswordInput): void {
  if (password.source !== "plain" && password.source !== "hashed") {
    throw new Error(`invalid password source ${JSON.stringify(password.source)}`);
  }
  if (password.encoded === "") {
    throw new Error("password is required");
  }
}

/**
 * 获取密码在传输中使用的值。
 * 先验证密码的合法性，然后返回编码后的密码值。
 *
 * @param password - 密码输入对象
 * @returns 传输用的密码字符串（bcrypt 哈希值）
 * @throws 如果密码输入非法则抛出错误
 */
export function passwordWireValue(password: PasswordInput): string {
  validatePassword(password);
  return password.encoded;
}
