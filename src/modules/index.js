import identity from "./identity.js";
import ai from "./ai.js";

/**
 * 模块注册表。
 *
 * 这里刻意用显式数组而不是扫目录自动加载 —— TG 端功能不多，
 * 显式列表看得见顺序、好断点、不需要热重载那套机制。
 * 新增模块：写好 { name, register(bot) }，在这里 import 并加进数组。
 */
export const modules = [identity, ai];
