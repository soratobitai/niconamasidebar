import { sortProgramsByActivePoint } from '../render/sidebar.js';

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
        // 新着順：notifybox API は「放送開始が新しい順」で番組を返すため、その並び順(data-api-index 昇順)を保つ。
        // ※lv番号(ID)は予約/作成順で放送開始順とズレる（予約枠など）ため、番号ではなくAPIの並びを採用する。
        // data-api-index が無いカードは末尾側へ回し、その中では lv番号降順でフォールバック。
        const programs = Array.from(container.children);
        programs.sort((a, b) => {
            const ia = a.dataset.apiIndex !== undefined ? (parseInt(a.dataset.apiIndex, 10) || 0) : Infinity;
            const ib = b.dataset.apiIndex !== undefined ? (parseInt(b.dataset.apiIndex, 10) || 0) : Infinity;
            if (ia !== ib) return ia - ib; // API順（＝放送開始が新しい順）を保つ
            const idA = parseInt(a.id, 10) || 0;
            const idB = parseInt(b.id, 10) || 0;
            return idB - idA;
        });
        programs.forEach((program) => container.appendChild(program));
    }
}

