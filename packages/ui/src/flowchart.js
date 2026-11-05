import mermaid from 'mermaid'

mermaid.initialize({
  startOnLoad: false, securityLevel: 'strict', theme: 'base',
  themeVariables: { fontFamily: 'system-ui, sans-serif', fontSize: '15px',
    primaryColor: '#e3f4ed', primaryTextColor: '#173f35', primaryBorderColor: '#55a48a',
    lineColor: '#4c9680', secondaryColor: '#fff3dc', tertiaryColor: '#f3f8f5',
    edgeLabelBackground: '#ffffff', mainBkg: '#e3f4ed' },
  flowchart: { htmlLabels: false, curve: 'basis', nodeSpacing: 48, rankSpacing: 64, padding: 18 }
})
let sequence = 0
export async function renderFlowchart(container, source) {
  try {
    if (typeof source !== 'string' || !source.trim() || source.length > 16000 ||
        /%%\s*\{|^\s*---|^\s*click\b/im.test(source)) throw new Error('Unsupported diagram')
    const { svg } = await mermaid.render(`workflow-chart-${++sequence}`, source)
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') throw new Error('Invalid SVG')
    container.replaceChildren(document.importNode(doc.documentElement, true))
  } catch {
    container.textContent = 'Could not display the flowchart.'
  }
}
