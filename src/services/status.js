const checkLiveStatus = async () => {
    const url = location.href

    try {
        const res = await fetch(url, {
            headers: {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache'
            }
        })

        const html = await res.text()
        const doc = new DOMParser().parseFromString(html, 'text/html')
        const jsonScript = doc.querySelector('#embedded-data')
        const data = JSON.parse(jsonScript?.getAttribute('data-props') ?? '{}')
        const status = data?.program?.status

        return status

    } catch (error) {
        console.error('ライブ状態の取得に失敗しました:', error)
        return 'ERROR'
    }
}

export { checkLiveStatus }


