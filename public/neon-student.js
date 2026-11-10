const $ = s => document.querySelector(s);
let token = sessionStorage.getItem('simple_exam_token') || '';
let queue = Promise.resolve();
const failed = new Set();
let pending = 0, clock, paper = null, current = 0, confirmed = {}, submitting = false;
async function api(path, body) {
  const res = await fetch('/api/simple/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-Exam-Token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data; try { data = await res.json(); } catch { throw new Error('Could not reach the exam server.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function error(message) { $('#message').textContent = message; $('#message').classList.remove('hidden'); }
function showResult(a) { clearInterval(clock); $('#exam').classList.add('hidden'); $('#join').classList.add('hidden'); $('#result').classList.remove('hidden'); $('#score').textContent = `Score: ${a.score} / ${a.total}`; sessionStorage.removeItem('simple_exam_token'); }
function paint() {
  if (!paper || !paper.questions.length) return;
  const q = paper.questions[current]; const target = $('#questions'); target.replaceChildren();
  $('#qChip').textContent = `Question ${current + 1}`; $('#position').textContent = `${current + 1} of ${paper.questions.length}`;
  $('#prev').disabled = current === 0; $('#next').disabled = current === paper.questions.length - 1;
  const title = document.createElement('div'); title.className = 'qprompt'; title.textContent = q.prompt; target.append(title);
  const choices = document.createElement('div'); choices.className = 'choices';
  q.choices.forEach((choice, n) => {
    const label = document.createElement('label'); label.className = `choice${paper.answers[q.id] === n ? ' selected' : ''}`;
    const input = document.createElement('input'); input.type = 'radio'; input.name = `q-${q.id}`; input.value = String(n); input.checked = paper.answers[q.id] === n; input.disabled = submitting;
    const text = document.createElement('span'); text.textContent = choice; label.append(input, text); choices.append(label);
    input.addEventListener('change', () => {
      paper.answers[q.id] = n; pending++; $('#save').textContent = 'Saving…'; $('#message').classList.add('hidden'); paint();
      queue = queue.catch(() => {}).then(async () => {
        await api('attempt/answer', { questionId:q.id, answer:n }); confirmed[q.id] = n; failed.delete(q.id);
      }).catch(err => {
        failed.add(q.id);
        if (paper.answers[q.id] === n) { if (confirmed[q.id] === undefined) delete paper.answers[q.id]; else paper.answers[q.id] = confirmed[q.id]; }
        error('Your answer could not be saved. Please select it again. ' + err.message); paint();
      }).finally(() => { pending--; $('#save').textContent = pending ? 'Saving…' : failed.size ? 'Some answers did not save.' : 'Answer saved.'; });
    });
  }); target.append(choices);
  const palette = $('#palette'); palette.replaceChildren();
  paper.questions.forEach((question, i) => { const button = document.createElement('button'); button.type = 'button'; button.className = `pal${paper.answers[question.id] !== undefined ? ' answered' : ''}${i === current ? ' current' : ''}`; button.textContent = String(i + 1); button.setAttribute('aria-label', `Question ${i + 1}${paper.answers[question.id] !== undefined ? ', answered' : ', unanswered'}`); if (i === current) button.setAttribute('aria-current', 'step'); button.addEventListener('click', () => { current = i; paint(); }); palette.append(button); });
  $('#progress').textContent = `${Object.keys(paper.answers).length} / ${paper.questions.length}`;
}
function render(a) {
  paper = a; confirmed = { ...a.answers }; current = 0; $('#join').classList.add('hidden'); $('#exam').classList.remove('hidden'); document.body.classList.add('exam-body'); $('#title').textContent = a.title; paint();
  const tick = () => { const seconds = Math.max(0, Math.ceil((new Date(a.deadline).getTime() - Date.now()) / 1000)); $('#timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining`; if (!seconds) { clearInterval(clock); finish(true); } };
  clearInterval(clock); clock = setInterval(tick, 1000); tick();
}
async function load() { const a = await api('attempt'); if (a.submitted) showResult(a); else render(a); }
async function finish(expired = false) {
  const buttons = [$('#submit'), $('#submitTop')]; if (buttons[0].disabled) return;
  if (!expired && !confirm('Submit your exam? You cannot change answers afterward.')) return;
  submitting = true; buttons.forEach(b => { b.disabled = true; }); paint(); await queue;
  if (failed.size && !expired) { error('An answer did not save. Select it again before submitting.'); submitting = false; buttons.forEach(b => { b.disabled = false; }); paint(); return; }
  try { const a = await api('attempt/submit', {}); showResult(a); } catch(e) { error(e.message); submitting = false; buttons.forEach(b => { b.disabled = false; }); paint(); }
}
$('#prev').addEventListener('click', () => { if (current > 0) { current--; paint(); } });
$('#next').addEventListener('click', () => { if (paper && current < paper.questions.length - 1) { current++; paint(); } });
$('#submit').addEventListener('click', () => finish()); $('#submitTop').addEventListener('click', () => finish());
$('#joinForm').addEventListener('submit', async e => { e.preventDefault(); const b = e.currentTarget.querySelector('button'); b.disabled = true; $('#message').classList.add('hidden'); try { const r = await api('join', { code:$('#code').value, name:$('#name').value, number:$('#number').value }); token = r.token; sessionStorage.setItem('simple_exam_token',token); await load(); } catch(e) { error(e.message); } finally { b.disabled = false; } });
if (token) load().catch(e => error(e.message));
