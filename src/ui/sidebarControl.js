import { sidebarMinWidth } from '../config/constants.js'
import { setIsOpenSidebar, setSidebarWidth } from '../services/storage.js'

export function createSidebarControl(elems, state) {

    function setRootWidth() {
        if (!elems.root || !elems.sidebar) return
        // CSS transition中の場合は、次のフレームで再実行する
        // これにより、transition開始直後に実行される場合でも、実際の幅が確定した後に調整される
        requestAnimationFrame(() => {
            const actualSidebarWidth = elems.sidebar.offsetWidth
            const calculatedWidth = window.innerWidth - actualSidebarWidth - 20
            elems.root.style.width = calculatedWidth + 'px'
            elems.root.style.maxWidth = calculatedWidth + 'px'
        })
    }

    function openSidebar() {
        if (state.sidebarWidth.value < sidebarMinWidth) state.sidebarWidth.value = sidebarMinWidth
        elems.sidebar.style.width = state.sidebarWidth.value + 'px'
        elems.sidebar.style.maxWidth = state.sidebarWidth.value + 'px'
        elems.sidebar.style.minWidth = state.sidebarWidth.value + 'px'
        elems.sidebar_container.style.width = state.sidebarWidth.value + 'px'

        sidebar_arrow.classList.add('sidebar_arrow_re')
        elems.sidebar_line.classList.add('col_resize')
        setRootWidth()
    }

    function closeSidebar() {
        elems.sidebar.style.width = 0 + 'px'
        elems.sidebar.style.maxWidth = 0 + 'px'
        elems.sidebar.style.minWidth = 0 + 'px'

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

            startX = e.clientX
            startWidth = parseInt(document.defaultView.getComputedStyle(elems.sidebar).width, 10)
            document.documentElement.addEventListener('mousemove', onMouseMove)
            document.documentElement.addEventListener('mouseup', onMouseUp)
        })

        function onMouseMove(e) {
            let width = startWidth + (e.clientX - startX)
            if (width < sidebarMinWidth) width = sidebarMinWidth

            elems.sidebar.style.width = width + 'px'
            elems.sidebar.style.maxWidth = width + 'px'
            elems.sidebar.style.minWidth = width + 'px'
            elems.sidebar_container.style.width = width + 'px'
            state.sidebarWidth.value = width
        }

        function onMouseUp() {
            elems.sidebar.classList.add('sidebar_transition')
            document.documentElement.removeEventListener('mousemove', onMouseMove)
            document.documentElement.removeEventListener('mouseup', onMouseUp)
            setSidebarWidth(state.sidebarWidth.value)
            setRootWidth()
        }
    }

    return { setRootWidth, openSidebar, closeSidebar, toggleSidebar, enableSidebarLine }
}


