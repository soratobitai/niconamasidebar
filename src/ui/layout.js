export function adjustWatchPageChild(elems) {
	if (!elems || !elems.root) return

	let maxWidth = 1024 + 'px'
	let minWidth = 1024 + 'px'
	let width = 1024 + 'px'
	const watchPageChildren = [
		elems.playerSection,
		elems.programInformationBodyArea,
		elems.siteFooterUtility,
		elems.gaNsProgramSummary,
		elems.enquetePlaceholder,
	]

	const watchPageWidth = elems.watchPage ? elems.watchPage.clientWidth : 0

	if (isScreenSizeAuto()) {
		if (watchPageWidth > 1152 && watchPageWidth < 1500) {
			maxWidth = watchPageWidth - 128 + 'px'
			minWidth = 1024 + 'px'
			width = window.innerHeight * 1.777778 - 3.55556 + 'px'
		}
		if (watchPageWidth > 1500 && watchPageWidth < 1792) {
			maxWidth = watchPageWidth - 128 + 'px'
			minWidth = 1024 + 'px'
			width = window.innerHeight * 1.777778 - 220.44444 + 'px'
		}
		if (watchPageWidth > 1792) {
			maxWidth = 1664 + 'px'
			minWidth = 1024 + 'px'
			width = window.innerHeight * 1.777778 - 220.44444 + 'px'
		}
	}

	if (isFullScreen()) {
		maxWidth = '100%'
		minWidth = '100%'
		width = '100%'
	}

	watchPageChildren.forEach((elem) => {
		if (!elem) return
		elem.style.maxWidth = maxWidth
		elem.style.minWidth = minWidth
		elem.style.width = width
	})

	if (elems.watchPage && elems.watchPage.hasAttribute('data-player-layout-mode') && isScreenSizeAuto()) {
		if (elems.playerSection) {
			elems.playerSection.style.maxWidth = 'none'
			elems.playerSection.style.width = 'auto'
		}
		if (elems.leoPlayer && elems.root) {
			elems.leoPlayer.style.height = elems.root.clientWidth * 0.5625 - 164 + 'px'
		}
	} else {
		if (elems.leoPlayer) elems.leoPlayer.style.height = 'auto'
	}

	const playerDisplay = document.querySelector('[class*="_player-display_"]')
	if (playerDisplay) playerDisplay.removeAttribute('style')
}

export function setProgramContainerWidth(elems, sidebarWidth) {
	let programContainerWidth = '100%'
	if (sidebarWidth < 300) programContainerWidth = 100 + '%'
	if (sidebarWidth > 300) programContainerWidth = 100 / 2 + '%'
	if (sidebarWidth > 500) programContainerWidth = 100 / 3 + '%'
	if (sidebarWidth > 700) programContainerWidth = 100 / 4 + '%'
	if (sidebarWidth > 900) programContainerWidth = 100 / 5 + '%'
	if (sidebarWidth > 1100) programContainerWidth = 100 / 6 + '%'
	if (sidebarWidth > 1300) programContainerWidth = 100 / 7 + '%'
	if (sidebarWidth > 1500) programContainerWidth = 100 / 8 + '%'

	document.querySelectorAll('.program_container').forEach((element) => {
		element.style.width = programContainerWidth
		const program_thumbnail = element.querySelector('.program_thumbnail')
		if (program_thumbnail) program_thumbnail.style.width = programContainerWidth + 'px'
	})
}

function isScreenSizeAuto() {
	const value = localStorage.getItem('LeoPlayer_ScreenSizeStore_kind')
	if (!value) return true
	return value.includes('auto')
}

function isFullScreen() {
	const htmlTag = document.getElementsByTagName('html')[0]
	return htmlTag.hasAttribute('data-browser-fullscreen')
}


