const paths = {
 clock:'M12 7v6l4 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 lock:'M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4 M12 15v2',
 eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
 clipboard:'M9 4H5v17h14V4h-4 M9 2h6v5H9z M8 14l3 3 5-6',
 message:'M3 3h18v15H9l-6 4z',
 'circle-arrow':'M8 12h8 m-4-4 4 4-4 4 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 'file-check':'M5 3h9l5 5v3 M14 3v6h5 M5 3v18h7 M14 17l3 3 5-6',
 book:'M4 4h6a3 3 0 0 1 3 2v14a4 4 0 0 0-3-2H4z M13 6a3 3 0 0 1 3-2h5v14h-5a4 4 0 0 0-3 2',
 bookmark:'M6 3h12v18l-6-4-6 4z', files:'M9 3h7l4 4v13H9z M16 3v5h4 M5 7H3v15h12v-2', file:'M5 3h9l5 5v13H5z M14 3v6h5 M9 13h6 M9 17h6',
 history:'M3 4v5h5 M3 9a9 9 0 1 1 0 6 M12 7v6l4 2', shield:'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z M8 12l3 3 5-6',
 search:'M21 21l-5-5 M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16', chevron:'m9 5 7 7-7 7', down:'m6 9 6 6 6-6', arrow:'M4 12h16 m-6-6 6 6-6 6', external:'M8 4h12v12 M20 4 4 20', info:'M12 11v6 M12 7v.1 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 help:'M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17v.1 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', panel:'M3 4h18v16H3z M8 4v16', menu:'M3 5h18 M3 12h18 M3 19h18', close:'m6 6 12 12 M18 6 6 18', upload:'M12 16V3 m-5 5 5-5 5 5 M4 15v6h16v-6', print:'M7 8V3h10v5 M6 17H3V9h18v8h-3 M7 14h10v7H7z M17 11h1',
 sliders:'M4 3v6 M4 13v8 M12 3v12 M12 19v2 M20 3v2 M20 9v12 M1 9h6 M9 15h6 M17 5h6', list:'M9 5h12 M9 12h12 M9 19h12 M3 3v4 M2 7h3 M2 11h3l-3 4h3 M2 18h3l-2 2h2', warning:'M12 3 1 21h22z M12 9v5 M12 17v.1',
 bug:'M8 8h8v8a4 4 0 0 1-8 0z M9 8V5h6v3 M4 6l4 4 M16 10l4-4 M3 14h5 M16 14h5 M4 21l4-4 M16 17l4 4 M12 8v12',
 heart:'M20 5c-4-4-8 1-8 1s-4-5-8-1c-5 6 8 16 8 16S25 11 20 5 M2 12h5l2-4 4 9 2-5h7',
 stethoscope:'M5 3v7a5 5 0 0 0 10 0V3 M3 3h4 M13 3h4 M10 15v3a4 4 0 0 0 8 0v-3 M21 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
 baby:'M12 2c4 0 1 4-1 3 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M8 11h.1 M16 11h.1 M8 15q4 4 8 0',
 wind:'M3 7h12a3 3 0 1 0-3-3 M3 12h16a3 3 0 1 1-3 3 M3 17h7a3 3 0 1 1-3 3', siren:'M7 18V9a5 5 0 0 1 10 0v9 M4 18h16v3H4z M12 1v1 M2 5l2 2 M22 5l-2 2 M1 12h2 M21 12h2', check:'m5 12 4 4L20 5'
}
export const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.book}"/></svg>`
