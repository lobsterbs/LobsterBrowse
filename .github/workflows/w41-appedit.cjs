const fs = require('fs');
const NL = String.fromCharCode(10);
const target = process.argv[2];
const lines = fs.readFileSync(target, 'utf8').split(NL);
for (let k = 0; k < lines.length; k++) {
  if (lines[k].indexOf('Welcome Back!') >= 0) { console.log('ALREADY-PRESENT'); process.exit(0); }
}
let i = -1;
for (let k = 0; k < lines.length - 1; k++) {
  if (lines[k] === '  }, [incognito]);' && lines[k + 1].startsWith('  /* #80:')) { i = k; break; }
}
if (i < 0) { console.error('ANCHOR-MISSING'); process.exit(1); }
const block = [
  '  /* Welcome Back: one snackbar on boot for returning profiles; the',
  '     very first visit only sets the marker. Local-only, never sent',
  '     server-side; storage failures behave like a first visit. */',
  '  useEffect(() => {',
  '    try {',
  '      if (localStorage.getItem("lb_visited")) {',
  '        if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {',
  '          M3eSnackbar.open("Welcome Back!", { duration: 4000 });',
  '        }',
  '      } else {',
  '        localStorage.setItem("lb_visited", "1");',
  '      }',
  '    } catch {',
  '      /* localStorage unavailable: behave like a first visit. */',
  '    }',
  '  }, []);'
];
lines.splice(i + 1, 0, ...block);
fs.writeFileSync(target, lines.join(NL));
console.log('INSERTED-AT-' + i);