export function reflowTable(lines, rowLines, rowParts, cols) {
  const widths = [];
  let i, j;
  for (j = 0; j < cols; j++) {
    let max = 0;
    for (i = 0; i < rowParts.length; i++) {
      const w = (rowParts[i][j] || '').trim().length;
      if (w > max) max = w;
    }
    if (max < 1) max = 1;
    widths.push(max);
  }
  let sepIdx = -1;
  for (i = 0; i < rowParts.length; i++) {
    let isSep = true;
    for (j = 0; j < rowParts[i].length; j++) {
      if (!/^-+$|^:-+$|^-+:$|^:-+:$/.test(rowParts[i][j].trim())) {
        isSep = false;
        break;
      }
    }
    if (isSep) {
      sepIdx = i;
      break;
    }
  }
  for (i = 0; i < rowParts.length; i++) {
    let rebuilt = '|';
    for (j = 0; j < cols; j++) {
      const cell = (rowParts[i][j] || '').trim();
      if (sepIdx === i) {
        const lc = cell[0] === ':' ? ':' : ' ';
        const rc = cell[cell.length - 1] === ':' ? ':' : ' ';
        rebuilt += lc + Array(widths[j] + 1).join('-') + rc + '|';
      } else {
        const pad = Math.max(1, widths[j] - cell.length + 1);
        rebuilt += ' ' + cell + Array(pad + 1).join(' ') + '|';
      }
    }
    lines[rowLines[i]] = rebuilt;
  }
  return widths;
}

export function getPipePositions(line) {
  const pipes = [];
  for (let i = 0; i < line.length; i++) if (line[i] === '|') pipes.push(i);
  return pipes;
}

export function getCellContentStart(line, pipeIndex) {
  let pos = pipeIndex + 1;
  while (pos < line.length && line[pos] === ' ') pos++;
  if (pos >= line.length || line[pos] === '|') return pipeIndex + 1;
  return pos;
}
