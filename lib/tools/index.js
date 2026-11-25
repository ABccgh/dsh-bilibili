/**
 * 工具定义聚合器：按模块拼装 20 个 `bili_*` 工具。
 *
 * 每个模块导出 `createXxxTools(deps) -> ToolDefinition[]`，这里只负责顺序与去重，
 * 不做任何业务逻辑，方便单测按模块替换。
 *
 * @module @local/bilibili/tools
 */

import { createCommunityTools } from './community.js';
import { createDownloadTools } from './download.js';
import { createHotwordTools } from './hotwords.js';
import { createLoginTools } from './login.js';
import { createMediaTools } from './media.js';
import { createPersonalTools } from './personal.js';
import { createSearchTools } from './search.js';
import { createStatusTools } from './status.js';
import { createUserTools } from './user.js';
import { createVideoTools } from './video.js';

/**
 * 拼装全部工具定义。
 * @param {object} deps - 由 `lib/index.js` 装配的依赖。
 * @returns {object[]} 工具定义数组（20 个）。
 */
export function createToolDefinitions(deps) {
  const definitions = [
    ...createStatusTools(deps),
    ...createSearchTools(deps),
    ...createVideoTools(deps),
    ...createUserTools(deps),
    ...createCommunityTools(deps),
    ...createMediaTools(deps),
    ...createHotwordTools(deps),
    ...createLoginTools(deps),
    ...createPersonalTools(deps),
    ...createDownloadTools(deps),
  ];

  /** @type {Set<string>} */
  const seen = new Set();
  for (const definition of definitions) {
    if (seen.has(definition.name)) throw new Error(`重复的工具名：${definition.name}`);
    seen.add(definition.name);
  }
  return definitions;
}
