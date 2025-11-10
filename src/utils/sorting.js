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
        // 新着順：番組IDでソート（IDが大きいほど新しい）
        const programs = Array.from(container.children);
        programs.sort((a, b) => {
            const idA = parseInt(a.id, 10) || 0;
            const idB = parseInt(b.id, 10) || 0;
            return idB - idA; // 降順（新しいものが上）
        });
        programs.forEach((program) => container.appendChild(program));
    }
}

