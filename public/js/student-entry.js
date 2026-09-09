import { api, toast, fmtClock } from './util.js';

const $ = (s) => document.querySelector(s);

let info = null;

async function loadInfo() {
  try {
    info = await api('/api/public/exam-info');
  } catch (err) {
    $('#heroTitle').textContent = 'Cannot reach the exam server';
    $('#heroMeta').textContent = err.message;
    return;
  }

  document.title = `${info.title} — Student Entry`;
  $('#heroSchool').textContent = info.school || 'RVM';
  $('#heroTitle').textContent = info.title;

  const bits = [info.subject, info.term].filter(Boolean);
  $('#heroMeta').textContent =
    bits.length ? bits.join(' · ') : 'Answer honestly. Your work is monitored and recorded.';

  $('#heroStats').innerHTML = [
    { k: 'Time limit', v: `${info.durationMinutes} min` },
    { k: 'Questions', v: info.totalQuestions },
    { k: 'Total points', v: info.totalPoints },
    { k: 'Sections', v: info.sections.length }
  ].map((s) => `<div class="hero-stat"><div class="v">${s.v}</div><div class="k">${s.k}</div></div>`).join('');

  if (info.proctorNotes) {
    const li = document.createElement('li');
    li.innerHTML = `<b>From your teacher:</b> ${info.proctorNotes.replace(/[<>]/g, '')}`;
    $('#rulesList').prepend(li);
  }

  if (!info.requireFullscreen) {
    $('#rulesList').children[1]?.remove();
  }

  // These two rules depend on how the teacher has configured the exam.
  if (info.lockSections) {
    $('#ruleNavigate').innerHTML =
      '<b>Sections lock.</b> Once you move past a section you cannot return to it.';
  }
  if (info.showResult) {
    $('#ruleScores').innerHTML =
      '<b>Your score is shown when you submit.</b> You can review each item afterwards.';
  }

  if (!info.examOpen) {
    const banner = document.createElement('div');
    banner.className = 'banner-closed';
    banner.textContent = 'This exam is currently closed by your teacher. Please wait for it to open.';
    $('.entry-panel .card-pad').prepend(banner);
    $('#startBtn').disabled = true;
  }

  tickClock();
  setInterval(tickClock, 1000);
}

function tickClock() {
  $('#clockLine').textContent = `Server time ${new Date().toLocaleTimeString()}`;
}

/* ------------------------------------------------------------------ form */

const agree = $('#fAgree');
const startBtn = $('#startBtn');
agree.addEventListener('change', () => { startBtn.disabled = !agree.checked || !info?.examOpen; });

$('#fCode').addEventListener('input', (e) => {
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  e.target.value = v.length === 3 && !v.includes('-') ? v + '-' : v;
});

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!agree.checked) return toast('Please confirm you will answer honestly.', 'warn');

  startBtn.disabled = true;
  startBtn.textContent = 'Verifying…';

  try {
    const res = await api('/api/sessions', {
      method: 'POST',
      body: {
        access_code: $('#fCode').value.trim(),
        student_name: $('#fName').value.trim(),
        student_no: $('#fNo').value.trim(),
        class_section: $('#fSection').value.trim()
      }
    });

    sessionStorage.setItem('rvm_token', res.token);
    sessionStorage.setItem('rvm_name', $('#fName').value.trim());
    sessionStorage.setItem('rvm_no', $('#fNo').value.trim());
    if (res.resumed) toast('Welcome back — resuming your saved attempt.', 'ok');

    const url = new URL('/exam', location.origin);
    url.searchParams.set('t', res.token);
    location.href = url.toString();
  } catch (err) {
    toast(err.message, 'bad', 5000);
    startBtn.disabled = !agree.checked;
    startBtn.textContent = 'Start examination';
  }
});

loadInfo();
