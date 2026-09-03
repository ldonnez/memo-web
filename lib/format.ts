export function reflowTable(lines: string[], rowLines: number[], rowParts: string[][], cols: number): number[] {
  const widths: number[] = []
  let i: number, j: number
  for (j = 0; j < cols; j++) {
    let max = 0
    for (i = 0; i < rowParts.length; i++) {
      const row = rowParts[i]!
      const w = (row[j] || '').trim().length
      if (w > max) max = w
    }
    if (max < 1) max = 1
    widths.push(max)
  }
  let sepIdx = -1
  for (i = 0; i < rowParts.length; i++) {
    const row = rowParts[i]!
    let isSep = true
    for (j = 0; j < row.length; j++) {
      if (!/^-+$|^:-+$|^-+:$|^:-+:$/.test((row[j] || '').trim())) {
        isSep = false
        break
      }
    }
    if (isSep) {
      sepIdx = i
      break
    }
  }
  for (i = 0; i < rowParts.length; i++) {
    const row = rowParts[i]!
    let rebuilt = '|'
    for (j = 0; j < cols; j++) {
      const cell = (row[j] || '').trim()
      if (sepIdx === i) {
        const lc = cell[0] === ':' ? ':' : ' '
        const rc = cell[cell.length - 1] === ':' ? ':' : ' '
        rebuilt += lc + Array(widths[j]! + 1).join('-') + rc + '|'
      } else {
        const pad = Math.max(1, widths[j]! - cell.length + 1)
        rebuilt += ' ' + cell + Array(pad + 1).join(' ') + '|'
      }
    }
    lines[rowLines[i]!] = rebuilt
  }
  return widths
}

export function getPipePositions(line: string): number[] {
  const pipes = []
  for (let i = 0; i < line.length; i++) if (line[i] === '|') pipes.push(i)
  return pipes
}

export function getCellContentStart(line: string, pipeIndex: number): number {
  let pos = pipeIndex + 1
  while (pos < line.length && line[pos] === ' ') pos++
  if (pos >= line.length || line[pos] === '|') return pipeIndex + 1
  return pos
}
