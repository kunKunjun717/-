// ==UserScript==
// @name         新境智慧教学平台 纯题库自动答题助手（优化匹配版）
// @namespace    http://tampermonkey.net/
// @version      9.1
// @description  仅使用本地题库自动答题，优化归一化匹配，支持切换部分/题型，集成题库管理
// @match        https://myccr.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    'use strict';

    const ANSWER_DELAY = 1500;
    const MULTI_CLICK_DELAY = 100;
    const TAB_WAIT = 2000;
    const AUTO_SUBMIT = false;
    const DEBUG = true;

    // ---------- 题库模块（IndexedDB）----------
    const DB_NAME = 'ExamHelperDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'questions';
    let db = null;

    function openDB() {
        return new Promise((resolve, reject) => {
            if (db) { resolve(db); return; }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { db = request.result; resolve(db); };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('stemNormalized', 'stemNormalized', { unique: true });
                    store.createIndex('type', 'type');
                }
            };
        });
    }

    async function addQuestion(questionData) {
        await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        return new Promise((resolve, reject) => {
            const request = store.put(questionData);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    }

    async function findQuestionByStem(stemNormalized) {
        await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('stemNormalized');
        return new Promise((resolve) => {
            const request = index.get(stemNormalized);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
        });
    }

    async function getAllQuestions() {
        await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        return new Promise((resolve) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve([]);
        });
    }

    async function deleteQuestion(id) {
        await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        return new Promise((resolve) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve(true);
            request.onerror = () => resolve(false);
        });
    }

    async function clearDB() {
        await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        return new Promise((resolve) => {
            const request = store.clear();
            request.onsuccess = () => resolve(true);
            request.onerror = () => resolve(false);
        });
    }

    async function exportDB() {
        const questions = await getAllQuestions();
        const dataStr = JSON.stringify(questions, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `exam_tiku_${new Date().toISOString().slice(0,19)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        log(`导出 ${questions.length} 条题目`);
    }

    async function importDB(jsonData) {
        try {
            const questions = JSON.parse(jsonData);
            if (!Array.isArray(questions)) throw new Error('格式错误');
            await clearDB();
            for (const q of questions) {
                await addQuestion(q);
            }
            log(`导入 ${questions.length} 条题目`);
            alert(`导入成功，共 ${questions.length} 条题目`);
        } catch (e) {
            log('导入失败', e);
            alert('导入失败：' + e.message);
        }
    }

    // ---------- 采集已答题目（使用新归一化）----------
    async function collectAnsweredQuestions() {
    log('开始采集当前页面的已答题目（从正确答案提示）...');
    const questionItems = document.querySelectorAll('.subject, .question-item, .exam-question');
    if (questionItems.length === 0) {
        alert('未找到题目，请确保在答题页面或结果页面');
        return;
    }

    let collected = 0, skipped = 0;
    for (const item of questionItems) {
        try {
            // 提取题干（只取第一个有效容器内的纯文本）
            let stem = '';
            const stemSelectors = ['.subject__content__desc', '.question-stem', '.title'];
            for (const sel of stemSelectors) {
                const stemEl = item.querySelector(sel);
                if (stemEl && stemEl.innerText.trim()) {
                    stem = cleanText(stemEl.innerText);
                    break;
                }
            }
            if (!stem) stem = cleanText(item.innerText.split('\n')[0] || '');
            // 重要：去除题干末尾的 (3分) 等分数信息（可能影响归一化）
            stem = stem.replace(/[（(]\d+分[）)]/g, '').trim();
            const stemNorm = normalizeText(stem);

            // 提取选项文本（同之前）
            const optionElements = item.querySelectorAll('.el-radio__label, .el-checkbox__label');
            const options = [];
            optionElements.forEach(opt => {
                let optText = cleanText(opt.innerText);
                optText = optText.replace(/^[A-Z]\.\s*/, '');
                if (optText) options.push(optText);
            });

            // 获取正确答案
            let answer = '', type = '';
            const correctLabel = item.querySelector('.label.blue.bold');
            if (correctLabel && correctLabel.innerText.includes('正确答案：')) {
                let rawAnswer = correctLabel.innerText.replace(/正确答案：/i, '').trim();
                const letters = rawAnswer.match(/[A-Z]/g);
                if (letters && letters.length > 0) rawAnswer = letters.join(',');
                if (rawAnswer.includes(',')) { type = 'multi'; answer = rawAnswer; }
                else if (/^[A-Z]$/i.test(rawAnswer)) { type = 'single'; answer = rawAnswer.toUpperCase(); }
                else if (rawAnswer === '对' || rawAnswer === '错') { type = 'judge'; answer = rawAnswer; }
                else { type = 'fill'; answer = rawAnswer; }
            }

            if (!answer) {
                log(`未找到正确答案提示，跳过: ${stem.substring(0,50)}`);
                skipped++; continue;
            }

            // 存入数据库
            await addQuestion({
                id: stemNorm,
                stem: stem,
                stemNormalized: stemNorm,
                options: options,
                type: type,
                answer: answer,
                part: '', section: '',
                createdAt: Date.now(),
                usedCount: 0, correctCount: 0
            });
            collected++;
            log(`✅ 已采集: ${stem.substring(0,40)}... 答案: ${answer}`);
        } catch(e) { log('采集单题失败', e); }
    }
    alert(`采集完成！成功 ${collected} 题，跳过 ${skipped} 题。`);
}

    // ---------- 工具函数 ----------
   function normalizeText(text) {
    // 移除所有非中文、字母、数字的字符（包括括号、空格、标点、分数等），转小写
    return text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase();
}

    function log(...args) {
        if (DEBUG) console.log('[答题助手]', ...args);
    }

    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const element = document.querySelector(selector);
            if (element) return resolve(element);
            const observer = new MutationObserver((mutations, obs) => {
                const el = document.querySelector(selector);
                if (el) { obs.disconnect(); resolve(el); }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { observer.disconnect(); reject(new Error(`等待元素超时: ${selector}`)); }, timeout);
        });
    }

    function clickTabByText(selector, text) {
        const tabs = document.querySelectorAll(selector);
        for (let tab of tabs) {
            if (tab.innerText.trim() === text) {
                tab.click();
                log(`点击选项卡: ${text}`);
                return true;
            }
        }
        log(`未找到选项卡: ${text}`);
        return false;
    }

    function cleanText(text) {
        return text.replace(/\s+/g, ' ').trim();
    }

    // ---------- 题目提取 ----------
    function extractQuestions() {
        const questions = [];
        const questionItems = document.querySelectorAll('.subject, .question-item, .exam-question');
        if (questionItems.length === 0) { log('未找到题目'); return []; }
        return extractFromElements(questionItems);

        function extractFromElements(elements) {
            elements.forEach((item, index) => {
                try {
                    let stem = '';
                    const stemSelectors = ['.subject__content__desc', '.question-stem', '.title'];
                    for (const sel of stemSelectors) {
                        const stemEl = item.querySelector(sel);
                        if (stemEl && stemEl.innerText.trim()) { stem = cleanText(stemEl.innerText); break; }
                    }
                    if (!stem) stem = cleanText(item.innerText.split('\n')[0] || '');

                    const optionElements = item.querySelectorAll('.el-radio__label, .el-checkbox__label');
                    const options = [];
                    optionElements.forEach(opt => {
                        let optText = cleanText(opt.innerText);
                        optText = optText.replace(/^[A-Z]\.\s*/, '');
                        if (optText) options.push(optText);
                    });

                    let type = 'choice';
                    if (item.querySelector('input[type="text"], textarea')) type = 'fill';
                    else if (stem.includes('判断') || stem.includes('√') || stem.includes('×')) type = 'judge';

                    const radios = item.querySelectorAll('input[type="radio"]');
                    const checkboxes = item.querySelectorAll('input[type="checkbox"]');
                    const textInputs = item.querySelectorAll('input[type="text"], textarea');

                    if (radios.length === 0 && checkboxes.length === 0 && optionElements.length > 0) {
                        questions.push({ index, stem, options, type, element: item, clickableOptions: optionElements });
                    } else {
                        questions.push({ index, stem, options, type, element: item, inputs: { radios, checkboxes, textInputs } });
                    }
                } catch(e) { log(`提取第${index}题失败:`, e); }
            });
            return questions;
        }
    }

    function matchOption(answer, options) {
        const letterMatch = answer.match(/^[A-D]$/i);
        if (letterMatch) {
            const idx = letterMatch[0].toUpperCase().charCodeAt(0) - 65;
            if (idx < options.length) return idx;
        }
        for (let i = 0; i < options.length; i++) {
            if (options[i].toLowerCase().includes(answer.toLowerCase()) ||
                answer.toLowerCase().includes(options[i].toLowerCase())) return i;
        }
        return -1;
    }

    // ---------- 自动答题（仅从题库获取）----------
    async function autoAnswer(question, partText, typeText) {
        const stemNorm = normalizeText(question.stem);
        log(`[匹配] 题干原文: ${question.stem.substring(0,60)}...`);
        log(`[匹配] 归一化后: ${stemNorm}`);
        const cached = await findQuestionByStem(stemNorm);
        let answer;
        if (cached) {
            answer = cached.answer;
            log(`✅ 题库命中: ${answer} (${cached.type})`);
        } else {
            log(`❌ 题库未命中，跳过`);
            return;
        }

        await new Promise(r => setTimeout(r, ANSWER_DELAY));
        if (question.options.length > 0) {
            const hasRadios = question.inputs && question.inputs.radios.length > 0;
            const hasCheckboxes = question.inputs && question.inputs.checkboxes.length > 0;
            const hasClickableOptions = question.clickableOptions && question.clickableOptions.length > 0;

            if (hasRadios) {
                const matchedIndex = matchOption(answer, question.options);
                if (matchedIndex !== -1 && question.inputs.radios[matchedIndex]) {
                    question.inputs.radios[matchedIndex].click();
                    log(`✓ 第${question.index+1}题 选择: ${String.fromCharCode(65+matchedIndex)}`);
                } else log(`✗ 第${question.index+1}题 无法匹配选项`);
            } else if (hasCheckboxes) {
                let letters = answer.match(/[A-Z]/gi) || [];
                letters = letters.map(l => l.toUpperCase());
                letters = [...new Set(letters)];
                let clickedCount = 0;
                for (const letter of letters) {
                    const idx = letter.charCodeAt(0) - 65;
                    if (idx >= 0 && idx < question.inputs.checkboxes.length) {
                        const cb = question.inputs.checkboxes[idx];
                        if (!cb.checked) { cb.click(); clickedCount++; await new Promise(r => setTimeout(r, MULTI_CLICK_DELAY)); }
                        else clickedCount++;
                    } else log(`警告: 字母 ${letter} 超出选项范围`);
                }
                if (clickedCount > 0) log(`✓ 第${question.index+1}题 多选题: ${letters.join(',')}`);
                else log(`✗ 第${question.index+1}题 未找到可点击的多选框`);
            } else if (hasClickableOptions) {
                let letters = answer.match(/[A-Z]/gi) || [];
                letters = letters.map(l => l.toUpperCase());
                letters = [...new Set(letters)];
                let clickedCount = 0;
                for (const letter of letters) {
                    const idx = letter.charCodeAt(0) - 65;
                    if (idx >= 0 && idx < question.clickableOptions.length) {
                        question.clickableOptions[idx].click();
                        clickedCount++;
                        await new Promise(r => setTimeout(r, MULTI_CLICK_DELAY));
                    } else log(`警告: 字母 ${letter} 超出选项范围`);
                }
                if (clickedCount > 0) log(`✓ 第${question.index+1}题 多选题（自定义点击）: ${letters.join(',')}`);
                else log(`✗ 第${question.index+1}题 未找到可点击的选项`);
            }
        } else if (question.inputs && question.inputs.textInputs.length > 0) {
            question.inputs.textInputs.forEach(input => {
                input.value = answer;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            log(`✓ 第${question.index+1}题 填空: ${answer.substring(0,50)}`);
        }
    }

    async function answerCurrentQuestions(partText, typeText) {
        const questions = extractQuestions();
        if (questions.length === 0) {
            await new Promise(r => setTimeout(r, 2000));
            return answerCurrentQuestions(partText, typeText);
        }
        log(`当前题型共 ${questions.length} 道题目`);
        for (const q of questions) await autoAnswer(q, partText, typeText);
    }

    function submitExam() {
        const btn = document.querySelector('.submit-btn, .submit, [type="submit"]');
        if (btn) { btn.click(); log('已点击提交按钮'); }
    }

    async function main() {
        log('纯题库模式启动，等待题目加载...');
        try { await waitForElement('.subject, .question-item, .exam-question', 15000); }
        catch(e) { log('未检测到题目区域'); return; }
        await new Promise(r => setTimeout(r, 2000));

        const PARTS = ['第1部分：识记题', '第2部分：理解题', '第3部分：应用题'];
        const TYPES = ['单选题', '多选题', '判断题'];

        for (const part of PARTS) {
            log(`切换到部分: ${part}`);
            clickTabByText('.el-radio-button__inner', part);
            await new Promise(r => setTimeout(r, TAB_WAIT));
            for (const type of TYPES) {
                log(`切换到题型: ${type}`);
                clickTabByText('span[data-v-436340a0]', type);
                await new Promise(r => setTimeout(r, TAB_WAIT));
                await answerCurrentQuestions(part, type);
            }
        }
        log('所有部分和题型处理完成');
        if (AUTO_SUBMIT) { await new Promise(r => setTimeout(r, 2000)); submitExam(); }
    }

    // ---------- 题库管理界面 ----------
    async function showQuestionBankPanel() {
        const panel = document.createElement('div');
        panel.style.cssText = `position:fixed; top:20px; right:20px; width:450px; max-height:600px; background:white; border:1px solid #ccc; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.2); z-index:1000000; display:flex; flex-direction:column; overflow:hidden; font-family:sans-serif;`;
        panel.innerHTML = `
            <div style="padding:10px; background:#4CAF50; color:white; display:flex; justify-content:space-between;">
                <span>📚 题库管理</span><button id="closePanel" style="background:none; border:none; color:white; cursor:pointer;">✖</button>
            </div>
            <div style="padding:10px; border-bottom:1px solid #eee; display:flex; gap:8px; flex-wrap:wrap;">
                <button id="exportBtn" style="background:#2196F3; color:white; border:none; padding:5px 10px; border-radius:4px;">导出JSON</button>
                <button id="importBtn" style="background:#FF9800; color:white; border:none; padding:5px 10px; border-radius:4px;">导入JSON</button>
                <button id="clearBtn" style="background:#f44336; color:white; border:none; padding:5px 10px; border-radius:4px;">清空题库</button>
                <button id="collectBtn" style="background:#9C27B0; color:white; border:none; padding:5px 10px; border-radius:4px;">采集当前已答题目</button>
            </div>
            <div style="flex:1; overflow-y:auto; padding:10px;"><div id="questionList">加载中...</div></div>
        `;
        document.body.appendChild(panel);
        document.getElementById('closePanel').onclick = () => panel.remove();
        document.getElementById('exportBtn').onclick = () => exportDB();
        document.getElementById('importBtn').onclick = () => {
            const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json';
            input.onchange = e => { const file = e.target.files[0]; const reader = new FileReader(); reader.onload = ev => importDB(ev.target.result); reader.readAsText(file); };
            input.click();
        };
        document.getElementById('clearBtn').onclick = async () => { if(confirm('清空所有题库？')){ await clearDB(); refreshList(); alert('已清空'); } };
        document.getElementById('collectBtn').onclick = async () => { const btn = document.getElementById('collectBtn'); btn.disabled=true; btn.textContent='采集中...'; await collectAnsweredQuestions(); btn.disabled=false; btn.textContent='采集当前已答题目'; refreshList(); };
        async function refreshList() {
            const listDiv = document.getElementById('questionList');
            const questions = await getAllQuestions();
            if(questions.length===0) { listDiv.innerHTML='暂无题目'; return; }
            listDiv.innerHTML = questions.map(q => `<div style="border-bottom:1px solid #eee; padding:8px 0;">
                <div><strong>${q.stem.substring(0,60)}</strong></div>
                <div style="font-size:12px; color:#666;">答案: ${q.answer} | 类型: ${q.type}</div>
                <div style="font-size:11px; color:#999;">归一化: ${q.stemNormalized}</div>
                <button data-id="${q.id}" class="deleteQuestion" style="background:#f44336; color:white; border:none; padding:2px 6px; border-radius:3px; cursor:pointer; font-size:12px;">删除</button>
            </div>`).join('');
            document.querySelectorAll('.deleteQuestion').forEach(btn => { btn.onclick = async () => { await deleteQuestion(btn.getAttribute('data-id')); refreshList(); }; });
        }
        refreshList();
    }

    function addBankButton() {
        const btn = document.createElement('button');
        btn.textContent = '📚 题库管理';
        btn.style.cssText = `position:fixed; bottom:20px; left:20px; z-index:999999; background:#FF9800; color:white; border:none; border-radius:8px; padding:12px 20px; font-size:14px; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,0.2); font-weight:bold;`;
        btn.onclick = () => showQuestionBankPanel();
        document.body.appendChild(btn);
        log('题库管理按钮已添加');
    }

    function addControlButton() {
        const btn = document.createElement('button');
        btn.textContent = '📚 纯题库自动答题';
        btn.style.cssText = `position:fixed; bottom:20px; right:20px; z-index:999999; background:#4CAF50; color:white; border:none; border-radius:8px; padding:12px 20px; font-size:14px; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,0.2); font-weight:bold;`;
        btn.onclick = async () => {
            if (!document.querySelector('.subject, .question-item, .exam-question')) {
                alert('当前页面未检测到题目，请进入答题页面后使用。');
                return;
            }
            btn.textContent = '答题中...'; btn.disabled = true;
            await main();
            btn.textContent = '✓ 完成';
            setTimeout(() => { btn.textContent = '📚 纯题库自动答题'; btn.disabled = false; }, 3000);
        };
        document.body.appendChild(btn);
        log('纯题库答题按钮已添加');
    }

    function init() {
        addBankButton();
        addControlButton();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();