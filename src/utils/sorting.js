import { orderComparator } from './programOrder.js';

/**
 * 番組リストを並べ替える。
 *
 * 🔴 **比較器は `utils/programOrder.js` の `orderComparator` ただ1つ。**
 *    2026-08-10 まではここで独自に if 分岐しており、`orderComparator` を使う
 *    `UpdateManager._sortOrderChanged` と**同じ規則が2箇所**にあった。食い違うと
 *    「並べ替えが必要」と毎周期判定され、replaceChildren と FLIP が走り続ける。
 *    おすすめ順を足す時にここを1本化した。
 *
 * @param {HTMLElement} container - 番組コンテナ
 * @param {string} sortType - 'newest' | 'active' | 'recommend'
 */
export function sortPrograms(container, sortType) {
    if (!container || container.children.length === 0) return;

    const programs = Array.from(container.children);
    programs.sort(orderComparator(sortType));
    programs.forEach((program) => container.appendChild(program));
}
