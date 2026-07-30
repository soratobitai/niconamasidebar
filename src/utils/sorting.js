import { sortProgramsByActivePoint } from '../render/sidebar.js';
import { compareByApiIndex } from './programOrder.js';

/**
 * 番組リストをソート
 * @param {HTMLElement} container - 番組コンテナ
 * @param {string} sortType - ソートタイプ ('active' or 'newest')
 */
export function sortPrograms(container, sortType) {
    if (!container || container.children.length === 0) return;
    
    if (sortType === 'active') {
        // 人気順：active-point属性でソート
        sortProgramsByActivePoint(container);
    } else {
        // 新着順：data-api-index 昇順を保つ。この属性は updateSidebar が「beginAt 降順」で
        // 並べた位置を書き込んだもの（＝放送開始が新しい順）。
        // ※lv番号(ID)は予約/作成順で放送開始順とズレる（予約枠など）ため、番号では並べない。
        // 比較器は utils/programOrder.js が唯一の定義。ここに書き直さないこと
        // （_sortOrderChanged と食い違うと、毎周期 replaceChildren＋FLIP が走る）。
        const programs = Array.from(container.children);
        programs.sort(compareByApiIndex);
        programs.forEach((program) => container.appendChild(program));
    }
}

