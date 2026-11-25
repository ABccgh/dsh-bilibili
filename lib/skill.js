/**
 * 注册运行期技能 `bilibili`。
 *
 * 技能正文来自包内 `skills/bilibili/SKILL.md`，`resourceBase` 指向该目录，
 * 模型可以按需继续读该目录下的参考文件。
 *
 * @module @local/bilibili/skill
 */

import fs from 'node:fs';
import path from 'node:path';

/** 技能名（kebab-case，注册表要求）。 */
export const SKILL_NAME = 'bilibili';

/** 技能目录相对包根的位置。 */
export const SKILL_DIR = path.join('skills', 'bilibili');

/**
 * 读取技能正文并构造注册对象。
 * @param {{ packageDir: string }} options - 包根目录。
 * @returns {object | undefined} 技能定义；文件缺失时返回 undefined（不阻断插件激活）。
 */
export function createSkillDefinition({ packageDir }) {
  const directory = path.join(packageDir, SKILL_DIR);
  const file = path.join(directory, 'SKILL.md');
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  if (typeof content !== 'string' || content.trim() === '') return undefined;
  const description = firstDescription(content);
  return {
    name: SKILL_NAME,
    description,
    source: 'custom',
    content,
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: directory },
  };
}

/**
 * 从 SKILL.md 里取 `description:` 行，缺省时用固定短句。
 * @param {string} content - Markdown 正文。
 * @returns {string} 描述。
 */
function firstDescription(content) {
  const match = /^description:\s*(.+)$/m.exec(content);
  if (match !== null) return match[1].trim().replace(/^["']|["']$/g, '');
  return 'B 站查询与下载：工具选择、风控排障、扫码登录、播放与下载边界';
}
