// Small, local outline icons. Labels remain visible and provide the accessible
// name; these SVGs are decorative and never contain user-provided markup.
const paths = {
  plus:['M12 5v14','M5 12h14'],
  userPlus:['M15 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 3 17.5V19','M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z','M19 8v6','M16 11h6'],
  edit:['M12 20h9','M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z'],
  trash:['M4 7h16','M10 11v6M14 11v6','M5 7l1 13h12l1-13','M9 7V4h6v3'],
  reset:['M3 12a9 9 0 1 0 3-6.7','M3 4v5h5','M12 8v4l3 2'],
  refresh:['M20 7v5h-5','M4 17v-5h5','M5 9a7 7 0 0 1 12-3l3 6','M19 15a7 7 0 0 1-12 3l-3-6'],
  copy:['M8 8h12v12H8z','M16 8V4H4v12h4'],
  key:['M14 8a4 4 0 1 0-3.6 5.8L4 20v-3l2-2h2v-2l1.5-1.5','M17 8h.01'],
  eye:['M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z','M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  eyeOff:['M3 3l18 18','M10 6.2A12 12 0 0 1 12 6c6.5 0 10 6 10 6a13 13 0 0 1-3 3.4','M6.2 6.3A13 13 0 0 0 2 12s3.5 6 10 6c1 0 2-.2 2.8-.5','M10 10a3 3 0 0 0 4 4'],
  lock:['M6 10h12v10H6z','M9 10V7a3 3 0 0 1 6 0v3'],
  unlock:['M6 10h12v10H6z','M9 10V7a3 3 0 0 1 5.7-1.3'],
  clock:['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z','M12 7v5l3 2'],
  send:['M4 12h14','M13 7l5 5-5 5','M4 5v14'],
  ban:['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z','M5.6 5.6l12.8 12.8'],
  flag:['M5 21V4','M5 5c4-3 7 3 11 0v9c-4 3-7-3-11 0'],
  flagClear:['M5 21V4','M5 5c4-3 7 3 11 0v7','M13 17l2 2 5-5'],
  save:['M5 4h12l3 3v13H4V4z','M8 4v6h8V4','M8 20v-7h8v7'],
  download:['M12 3v12','M8 11l4 4 4-4','M4 17v3h16v-3'],
  help:['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z','M9.5 9a2.5 2.5 0 1 1 4 2c-1.1.8-1.5 1.2-1.5 2.5','M12 17h.01'],
  list:['M9 6h11M9 12h11M9 18h11','M4 6h.01M4 12h.01M4 18h.01'],
  chart:['M4 20h16','M6 17v-5M12 17V7M18 17V4'],
  book:['M4 5a3 3 0 0 1 3-2h13v16H7a3 3 0 0 0-3 2z','M4 5v16','M8 7h8M8 11h8'],
  settings:['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z','M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4'],
  logout:['M10 4H4v16h6','M14 8l4 4-4 4','M8 12h10'],
  check:['M4 12l5 5L20 6'],
  left:['M15 18l-6-6 6-6'],
  right:['M9 18l6-6-6-6'],
};
export function addIcon(element, name) {
  if (!element || !paths[name]) return;
  element.querySelector(':scope > svg.action-icon')?.remove();
  const ns='http://www.w3.org/2000/svg', svg=document.createElementNS(ns,'svg');
  for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'})) svg.setAttribute(key,value);
  svg.classList.add('action-icon');svg.dataset.icon=name;
  for(const d of paths[name]){const path=document.createElementNS(ns,'path');path.setAttribute('d',d);svg.append(path);}
  element.prepend(svg);
}
