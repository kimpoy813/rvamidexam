const $ = s => document.querySelector(s);
let token = sessionStorage.getItem('simple_exam_token') || '';
let queue = Promise.resolve(); const failed = new Set(); let clock;
async function api(path, body) {
  const res = await fetch('/api/simple/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-Exam-Token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data; try { data = await res.json(); } catch { throw new Error('Could not reach the exam server.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function error(message) { $('#message').textContent = message; $('#message').classList.remove('hidden'); }
function showResult(a) { clearInterval(clock); $('#exam').classList.add('hidden'); $('#join').classList.add('hidden'); $('#result').classList.remove('hidden'); $('#score').textContent = `Score: ${a.score} / ${a.total}`; sessionStorage.removeItem('simple_exam_token'); }
function render(a) {
  $('#join').classList.add('hidden'); $('#exam').classList.remove('hidden'); $('#title').textContent = a.title;
  const target = $('#questions'); target.replaceChildren();
  a.questions.forEach((q, i) => {
    const section = document.createElement('section'); section.className = 'question';
    const h = document.createElement('h2'); h.textContent = `${i + 1}. ${q.prompt}`; section.append(h);
    q.choices.forEach((choice, n) => {
      const label = document.createElement('label'); label.className = 'choice';
      const input = document.createElement('input'); input.type = 'radio'; input.name = `q-${q.id}`; input.value = String(n); input.checked = a.answers[q.id] === n;
      const text = document.createElement('span'); text.textContent = choice; label.append(input, text); section.append(label);
      input.addEventListener('change', () => {
        $('#save').textContent = 'Saving…';
        queue = queue.catch(() => {}).then(async () => { await api('attempt/answer', { questionId:q.id, answer:n }); failed.delete(q.id); $('#save').textContent = failed.size ? 'Some answers did not save. Select them again.' : 'Answer saved.'; }).catch(err => { failed.add(q.id); input.checked = false; $('#save').textContent = 'Could not save. Select your answer again before submitting.'; error(err.message); });
      });
    }); target.append(section);
  });
  const tick = () => { const seconds = Math.max(0, Math.ceil((new Date(a.deadline).getTime() - Date.now()) / 1000)); $('#timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining`; if (!seconds) { clearInterval(clock); finish(true); } };
  clearInterval(clock); tick(); clock = setInterval(tick, 1000);
}
async function load() { const a = await api('attempt'); if (a.submitted) showResult(a); else render(a); }
async function finish(expired = false) { const btn = $('#submit'); if (btn.disabled) return; if (!expired && !confirm('Submit your exam? You cannot change answers afterward.')) return; btn.disabled = true; await queue; if (failed.size && !expired) { error('An answer did not save. Select it again before submitting.'); btn.disabled = false; return; } try { const a = await api('attempt/submit', {}); showResult(a); } catch(e) { error(e.message); btn.disabled = false; } }
$('#submit').addEventListener('click', () => finish());
$('#joinForm').addEventListener('submit', async e => { e.preventDefault(); const b = e.currentTarget.querySelector('button'); b.disabled = true; $('#message').classList.add('hidden'); try { const r = await api('join', { code:$('#code').value, name:$('#name').value, number:$('#number').value }); token = r.token; sessionStorage.setItem('simple_exam_token',token); await load(); } catch(e) { error(e.message); } finally { b.disabled = false; } });
if (token) load().catch(e => error(e.message));
