import { sidebarMinWidth } from '../config/constants.js'
import { setIsOpenSidebar, setSidebarWidth } from '../services/storage.js'
import { OVERLAY_CLASS } from './placement.js'

export function createSidebarControl(elems, state) {

    /**
     * 今「重ねる」設定か。
     * ⚠️ **設定値ではなく `<html>` の印を見ること。** ここへ options を配ると、
     *    設定変更のたびに渡し直す約束が要る。印は `applySidebarPlacement` が1箇所で付ける。
     */
    function isOverlay() {
        try { return document.documentElement.classList.contains(OVERLAY_CLASS) } catch (e) { return false }
    }

    function setRootWidth() {
        if (!elems.root || !elems.sidebar) return
        // CSS transition中の場合は、次のフレームで再実行する
        // これにより、transition開始直後に実行される場合でも、実際の幅が確定した後に調整される
        requestAnimationFrame(() => {
            const actualSidebarWidth = elems.sidebar.offsetWidth

            // 境目ラインの置き場所（重ねる時だけ使う）。**本命は `applySidebarWidth`。**
            // ⚠️ ここは「幅を書かずに実寸が変わる経路」（窓の変形・他ページからの同期）の保険。
            //    rAF の中なので**1フレーム遅れる**。掴んでいる間の追従をここに頼らないこと
            //    （頼っていたせいで、ラインだけ遅れて付いてきた。2026-08-08・項目CE-2）。
            document.documentElement.style.setProperty('--nns-sb-w', actualSidebarWidth + 'px')

            // 🔴 **重ねる時はページの幅を触らない**（doc/09 項目CE）。
            //    ここで縮めるのが「寄せる」の実体。重ねる時に縮めると、
            //    場所を空けたうえに上から被せることになり、右側が無駄に空く。
            //    ⚠️ 空文字で消すこと。**前に入れた値が残るので、消さないと切り替えても戻らない。**
            if (isOverlay()) {
                elems.root.style.width = ''
                elems.root.style.maxWidth = ''
                return
            }
            const calculatedWidth = window.innerWidth - actualSidebarWidth - 20
            elems.root.style.width = calculatedWidth + 'px'
            elems.root.style.maxWidth = calculatedWidth + 'px'
        })
    }

    /**
     * サイドバーの幅を当てる。**幅を書く場所はここ1つだけにすること。**
     *
     * 🔴 重ねる時、境目ラインは `left: var(--nns-sb-w)` で位置が決まる。
     *    幅を書いた場所と変数を更新する場所が別だと、**ラインだけ遅れて付いてくる。**
     *    実際にそうなっていた（ドラッグ中は `onMouseMove` が幅だけ書き、変数は
     *    `setRootWidth()` の rAF まで更新されなかった）。
     *    kick.com で踏んだ「動かすものが2つに分かれてズレる」と同じ形（doc/09 項目BO）。
     *
     * ⚠️ **変数の更新を rAF に入れないこと。** 1フレーム遅れるとそのぶんラインが遅れる。
     */
    function applySidebarWidth(px) {
        elems.sidebar.style.width = px + 'px'
        elems.sidebar.style.maxWidth = px + 'px'
        elems.sidebar.style.minWidth = px + 'px'
        document.documentElement.style.setProperty('--nns-sb-w', px + 'px')
    }

    function openSidebar() {
        if (state.sidebarWidth.value < sidebarMinWidth) state.sidebarWidth.value = sidebarMinWidth
        applySidebarWidth(state.sidebarWidth.value)
        elems.sidebar_container.style.width = state.sidebarWidth.value + 'px'

        sidebar_arrow.classList.add('sidebar_arrow_re')
        elems.sidebar_line.classList.add('col_resize')
        setRootWidth()
    }

    function closeSidebar() {
        applySidebarWidth(0)

        sidebar_arrow.classList.remove('sidebar_arrow_re')
        elems.sidebar_line.classList.remove('col_resize')
        setRootWidth()
    }

    function toggleSidebar() {
        state.isOpenSidebar.value = !state.isOpenSidebar.value
        if (state.isOpenSidebar.value) openSidebar()
        else closeSidebar()
        setIsOpenSidebar(state.isOpenSidebar.value)
    }

    function enableSidebarLine() {
        let startX, startWidth
        elems.sidebar_line.addEventListener('mousedown', function (e) {
            e.preventDefault()
            e.stopPropagation()

            if (!state.isOpenSidebar.value) return
            if (e.target.id === 'sidebar_button' || e.target.id === 'sidebar_arrow') return

            elems.sidebar.classList.remove('sidebar_transition')
            // 🔴 **ラインにも同じ掛け外しをすること。** 重ねる時、ラインは `left` で動く。
            //    片方だけアニメを止めると、掴んでいる間ラインが 0.5秒遅れて追ってくる。
            elems.sidebar_line.classList.remove('sidebar_transition')

            startX = e.clientX
            startWidth = parseInt(document.defaultView.getComputedStyle(elems.sidebar).width, 10)
            document.documentElement.addEventListener('mousemove', onMouseMove)
            document.documentElement.addEventListener('mouseup', onMouseUp)
        })

        function onMouseMove(e) {
            let width = startWidth + (e.clientX - startX)
            if (width < sidebarMinWidth) width = sidebarMinWidth

            applySidebarWidth(width)
            elems.sidebar_container.style.width = width + 'px'
            state.sidebarWidth.value = width
        }

        function onMouseUp() {
            elems.sidebar.classList.add('sidebar_transition')
            elems.sidebar_line.classList.add('sidebar_transition')
            document.documentElement.removeEventListener('mousemove', onMouseMove)
            document.documentElement.removeEventListener('mouseup', onMouseUp)
            setSidebarWidth(state.sidebarWidth.value)
            setRootWidth()
        }
    }

    return { setRootWidth, openSidebar, closeSidebar, toggleSidebar, enableSidebarLine }
}


