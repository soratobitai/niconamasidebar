import { saveOptions as saveOptionsToStorage } from '../services/storage.js';

/**
 * オプション設定の反映とイベントハンドリング
 */
export function setupOptionsHandler(options, programInfoQueue, sortPrograms) {
    /**
     * チェックボックスの状態を更新
     */
    const updateCheckedState = (name, value) => {
        const elements = document.getElementsByName(name);
        if (elements.length === 0) return;
        
        elements.forEach(item => {
            item.checked = item.value === value;
        });
    };

    /**
     * オプションを保存
     */
    const saveOptions = () => {
        try {
            const autoOpenElement = document.querySelector('input[name="autoOpen"]:checked');
            const updateProgramsIntervalElement = document.querySelector('input[name="updateProgramsInterval"]:checked');
            const programsSortElement = document.querySelector('input[name="programsSort"]:checked');
            const autoNextProgramElement = document.querySelector('input[name="autoNextProgram"]:checked');
            const animatedThumbnailElement = document.querySelector('input[name="animatedThumbnail"]:checked');
            const dataSourceElement = document.querySelector('input[name="dataSource"]:checked');

            if (!autoOpenElement || !updateProgramsIntervalElement || !programsSortElement || !autoNextProgramElement) {
                return;
            }

            options.autoOpen = autoOpenElement.value;
            options.updateProgramsInterval = updateProgramsIntervalElement.value;
            options.programsSort = programsSortElement.value;
            options.autoNextProgram = autoNextProgramElement.value;
            // 動くサムネ（β版・後方互換のためガード対象外・存在すれば反映）
            if (animatedThumbnailElement) options.animatedThumbnail = animatedThumbnailElement.value;
            // データ取得方式（実験・後方互換のためガード対象外・存在すれば反映）
            if (dataSourceElement) options.dataSource = dataSourceElement.value;

            saveOptionsToStorage(options);
        } catch (error) {
            // エラーは静かに無視
        }
    };

    // 各設定を反映
    updateCheckedState('programsSort', options.programsSort);
    updateCheckedState('updateProgramsInterval', options.updateProgramsInterval);
    updateCheckedState('autoOpen', options.autoOpen);
    updateCheckedState('autoNextProgram', options.autoNextProgram);
    updateCheckedState('animatedThumbnail', options.animatedThumbnail);
    updateCheckedState('dataSource', options.dataSource);

    // フォームに変更があったら保存する
    const optionForm = document.getElementById('optionForm');
    if (optionForm) {
        optionForm.addEventListener('change', (event) => {
            if (event.target.name === 'programsSort') {
                // ソート方式変更時は既存データでソート（APIリクエストなし、ローディングなし）
                programInfoQueue.setShouldSort(true);
                
                // オプションを先に保存（ソート順を反映）
                saveOptions();
                
                // 既存のDOMをソート（統一関数を使用）
                const container = document.getElementById('liveProgramContainer');
                if (container) {
                    sortPrograms(container);
                }
                return; // saveOptions()は既に呼ばれているのでreturn
            }
            saveOptions();
        });
    }
}

