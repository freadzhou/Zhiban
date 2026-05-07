// ============ 全局状态 ============
let config = {};
let staffList = [];
let isModified = false;
let autoSaveTimer = null;
let isHistoryMode = false;
let currentLogDate = null;  // 当前使用的日志日期
let skipDateCheck = false;  // 是否跳过日期检查（用户选择继续使用当前日志时）
let dateCheckTimer = null;  // 日期检查定时器
let dateChangeUpdateTimer = null;  // 日期变更弹窗的日期更新定时器
let pendingContactSort = false;  // 联系记录是否需要排序（等待触发时机）
let currentEditingContactRow = null;  // 当前正在编辑的联系记录行

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();
    initEquipmentTable();
    initContactTable();
    initMultiSelects();
    startClock();
    startDateCheck();  // 启动日期检查定时器
    // 注意：自动保存在日志加载完成后启动，避免初始化时保存空数据
    loadLanAccessStatus();  // 加载局域网访问状态
    
    // 初始化时重置修改标志（initContactTable 会触发 markModified）
    isModified = false;
    
    const hash = window.location.hash.substring(1);
    if (hash) {
        isHistoryMode = true;
        // 工具栏调整：隐藏常规按钮，显示醒目提示
        document.getElementById('toolbarNormalButtons').style.display = 'none';
        document.getElementById('historyModeAlert').style.display = 'block';
        // 日期字段设置为可编辑
        document.getElementById('logDate').removeAttribute('readonly');
        document.getElementById('auditDate').removeAttribute('readonly');
        document.getElementById('logDate').style.background = '';
        document.getElementById('logDate').style.cursor = '';
        document.getElementById('auditDate').style.background = '';
        document.getElementById('auditDate').style.cursor = '';
        
        if (hash === 'local-file') {
            // 从 localStorage 读取本地文件数据
            const localData = localStorage.getItem('local_log_data');
            if (localData) {
                try {
                    const data = JSON.parse(localData);
                    loadData(data);
                    localStorage.removeItem('local_log_data');
                } catch (e) {
                    alert('加载本地文件失败：' + e.message);
                }
            }
        } else {
            await loadLog(hash);
        }
        // 日志加载完成后启动自动保存
        startAutoSave();
    } else {
        initDateDisplay();
        // 记录初始日志日期
        currentLogDate = getLogDate();
        await loadTodayLog();
        // 日志加载完成后启动自动保存
        startAutoSave();
    }
    
    document.querySelectorAll('input, textarea, select').forEach(el => {
        // 排除局域网开关等不需要触发修改标记的元素
        if (el.dataset.skipModified) return;
        el.addEventListener('change', markModified);
        if (el.type === 'text' || el.tagName === 'TEXTAREA') {
            el.addEventListener('input', markModified);
        }
    });
    
    window.addEventListener('beforeunload', (e) => {
        if (isModified) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
});

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        config = await res.json();
        staffList = config.staff_list || [];
    } catch (e) {
        console.error('加载配置失败:', e);
        alert('加载配置失败，请检查后端服务是否启动');
    }
}

function initEquipmentTable() {
    const tbody = document.querySelector('#equipmentTable tbody');
    tbody.innerHTML = '';
    config.equipment_list.forEach((eq, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${i + 1}</td>
            <td style="text-align: left; padding-left: 12px; font-weight: 500;">${eq}</td>
            ${config.time_slots.map(slot => `
                <td>
                    <select class="table-select" data-equipment="${eq}" data-slot="${slot}" onchange="markModified()">
                        <option value="正常">正常</option>
                        <option value="故障">故障</option>
                        <option value="停用">停用</option>
                    </select>
                </td>
            `).join('')}
        `;
        tbody.appendChild(tr);
    });
}

// ============ 机坪联系记录 - 时间戳处理 ============
/**
 * 判断时间是否处于凌晨时段（0:00 ~ 8:00）
 * @param {string} timeStr - 时间字符串，格式如 "01:20"
 * @returns {boolean}
 */
function isEarlyMorningTime(timeStr) {
    if (!timeStr) return false;
    const hours = parseInt(timeStr.split(':')[0], 10);
    return hours >= 0 && hours < 8;
}

/**
 * 计算凌晨时段时间戳的日期
 * 时间戳日期 = 日志日期 + 1天
 * @returns {string} 格式如 "[4月11日]"
 */
function calculateTimestampDate() {
    const logDateStr = document.getElementById('logDate').value;
    if (!logDateStr) return '';
    
    const logDate = new Date(logDateStr);
    logDate.setDate(logDate.getDate() + 1);  // 加一天
    
    const month = logDate.getMonth() + 1;
    const day = logDate.getDate();
    return `[${month}月${day}日]`;
}

/**
 * 检测事由内容中是否已存在时间戳
 * @param {string} reason - 事由内容
 * @returns {boolean}
 */
function hasTimestamp(reason) {
    if (!reason) return false;
    // 正则匹配 "[X月X日]" 格式
    const timestampRegex = /^\[\d+月\d+日\]/;
    return timestampRegex.test(reason);
}

/**
 * 从事由内容中提取时间戳
 * @param {string} reason - 事由内容
 * @returns {string|null} 时间戳部分，如 "[4月11日]"
 */
function extractTimestamp(reason) {
    if (!reason) return null;
    const timestampRegex = /^\[\d+月\d+日\]/;
    const match = reason.match(timestampRegex);
    return match ? match[0] : null;
}

/**
 * 从事由内容中移除时间戳
 * @param {string} reason - 事由内容
 * @returns {string} 移除时间戳后的内容
 */
function removeTimestamp(reason) {
    if (!reason) return '';
    const timestampRegex = /^\[\d+月\d+日\]/;
    return reason.replace(timestampRegex, '').trim();
}

/**
 * 向事由内容添加时间戳（在最前端）
 * @param {string} reason - 事由内容
 * @param {string} timestamp - 时间戳，如 "[4月11日]"
 * @returns {string} 添加时间戳后的内容
 */
function addTimestamp(reason, timestamp) {
    if (!timestamp) return reason;
    // 如果已有时间戳，先移除再添加新的
    const cleanReason = removeTimestamp(reason);
    return cleanReason ? `${timestamp} ${cleanReason}` : timestamp;
}

/**
 * 处理联系记录的时间变化，自动管理时间戳
 * @param {HTMLInputElement} timeInput - 时间输入框元素
 * @param {HTMLInputElement|HTMLElement} reasonInput - 事由输入框元素
 */
function handleContactTimestamp(timeInput, reasonCell) {
    const timeValue = timeInput.value;
    const isEarlyMorning = isEarlyMorningTime(timeValue);

    // 检查是否有时间戳包装器
    const wrapper = reasonCell.querySelector('.reason-input-wrapper');
    const hasWrapper = wrapper !== null;

    // 获取事由内容
    let reasonValue;
    let reasonInputElement;
    
    if (hasWrapper) {
        // 带时间戳包装器的情况（当天日志模式）
        reasonInputElement = wrapper.querySelector('.reason-input-with-timestamp');
        reasonValue = reasonInputElement ? reasonInputElement.value : '';
    } else {
        // 普通输入框（历史日志模式或非凌晨时段）
        reasonInputElement = reasonCell.querySelector('.table-input');
        reasonValue = reasonInputElement ? reasonInputElement.value : '';
    }

    if (isEarlyMorning) {
        // 凌晨时段：需要时间戳
        const timestamp = calculateTimestampDate();
        
        if (isHistoryMode) {
            // 历史日志模式：直接在输入框内容中添加/更新时间戳
            if (reasonInputElement) {
                if (!hasTimestamp(reasonValue)) {
                    reasonInputElement.value = addTimestamp(reasonValue, timestamp);
                    markModified();
                }
            }
        } else {
            // 当天日志模式
            if (hasWrapper) {
                // 已有包装器，更新时间戳显示（日期可能变化）
                const timestampEl = wrapper.querySelector('.reason-timestamp');
                if (timestampEl) timestampEl.textContent = timestamp;
            } else {
                // 没有包装器，创建一个
                updateReasonInputWithTimestamp(reasonCell, timestamp, reasonValue);
                markModified();
            }
        }
    } else {
        // 非凌晨时段：需要移除时间戳
        if (isHistoryMode) {
            // 历史日志模式：直接从内容中移除时间戳
            if (reasonInputElement && hasTimestamp(reasonValue)) {
                reasonInputElement.value = removeTimestamp(reasonValue);
                markModified();
            }
        } else {
            // 当天日志模式：移除包装器
            if (hasWrapper) {
                updateReasonInputWithoutTimestamp(reasonCell, reasonValue);
                markModified();
            }
        }
    }
}

/**
 * 更新事由输入框为带时间戳的样式（当天日志模式）
 * @param {HTMLElement} cell - 事由单元格
 * @param {string} timestamp - 时间戳
 * @param {string} reason - 事由内容
 */
function updateReasonInputWithTimestamp(cell, timestamp, reason) {
    // 检查是否已经有包装器
    if (cell.querySelector('.reason-input-wrapper')) {
        // 更新时间戳显示
        const timestampEl = cell.querySelector('.reason-timestamp');
        const inputEl = cell.querySelector('.reason-input-with-timestamp');
        if (timestampEl) timestampEl.textContent = timestamp;
        if (inputEl) inputEl.value = removeTimestamp(reason);
    } else {
        // 创建包装器
        const wrapper = document.createElement('div');
        wrapper.className = 'reason-input-wrapper';
        wrapper.innerHTML = `
            <span class="reason-timestamp">${timestamp}</span>
            <input type="text" class="reason-input-with-timestamp" value="${removeTimestamp(reason)}" placeholder="事由..." onchange="markModified()">
        `;
        cell.innerHTML = '';
        cell.appendChild(wrapper);
    }
}

/**
 * 更新事由输入框为不带时间戳的样式（当天日志模式）
 * @param {HTMLElement} cell - 事由单元格
 * @param {string} reason - 事由内容
 */
function updateReasonInputWithoutTimestamp(cell, reason) {
    // 恢复普通输入框
    cell.innerHTML = `<input type="text" class="table-input" style="text-align: left;" value="${reason}" placeholder="事由..." onchange="markModified()">`;
}

function initContactTable() {
    const tbody = document.querySelector('#contactTable tbody');
    tbody.innerHTML = '';
    addContactRow();
}

function addContactRow() {
    const tbody = document.querySelector('#contactTable tbody');
    
    // 先对现有记录排序（如果有待排序）
    if (pendingContactSort && tbody.rows.length > 1) {
        sortContactTable(true);
        pendingContactSort = false;
    }
    
    const rowCount = tbody.rows.length + 1;
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td>${rowCount}</td>
        <td><input type="time" class="table-input contact-time-input" value="" onchange="onContactTimeChange(this)"></td>
        <td>
            <select class="table-select" onchange="markModified()">
                <option value="" disabled selected>请选择...</option>
                ${config.contact_systems.map(s => `<option value="${s}">${s}</option>`).join('')}
            </select>
        </td>
        <td>
            <select class="table-select" onchange="markModified()">
                <option value="" disabled selected>请选择...</option>
                <option value="接到报修">接到报修</option>
                <option value="处理结果">处理结果</option>
            </select>
        </td>
        <td class="reason-cell"><input type="text" class="table-input" style="text-align: left;" placeholder="事由..." onchange="markModified()"></td>
        <td><button class="btn btn-danger" onclick="removeContactRow(this)">×</button></td>
    `;
    
    // 给行添加焦点事件监听
    tr.addEventListener('focusin', () => {
        currentEditingContactRow = tr;
    });
    tr.addEventListener('focusout', (e) => {
        // 检查焦点是否还在同一行内
        setTimeout(() => {
            if (currentEditingContactRow === tr) {
                // 焦点已离开该行，检查是否需要排序
                if (pendingContactSort) {
                    sortContactTable(true);
                    pendingContactSort = false;
                }
                currentEditingContactRow = null;
            }
        }, 50);
    });
    
    tbody.appendChild(tr);
    markModified();
}

/**
 * 联系记录时间变化时的回调函数
 * @param {HTMLInputElement} timeInput - 时间输入框
 */
function onContactTimeChange(timeInput) {
    const row = timeInput.closest('tr');
    const reasonCell = row.querySelector('.reason-cell');
    handleContactTimestamp(timeInput, reasonCell);
    markModified();
    
    // 标记需要排序（不立即执行，等用户离开该行时触发）
    if (timeInput.value) {
        pendingContactSort = true;
    }
}

// ============ 机坪联系记录 - 自动排序 ============
/**
 * 获取联系记录时间的排序值
 * 排序规则：08:00~23:59 排在前面，00:00~07:59 排在后面
 * @param {string} timeStr - 时间字符串，格式如 "01:20"
 * @returns {number} 排序值
 */
function getContactTimeSortValue(timeStr) {
    if (!timeStr) return 999; // 无时间的排在最后
    
    const parts = timeStr.split(':');
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    
    // 08:00~23:59 保持原值 (8~23.98)
    // 00:00~07:59 加24小时，排在后面 (24~31.98)
    if (hours < 8) {
        return hours + 24 + minutes / 60;
    } else {
        return hours + minutes / 60;
    }
}

/**
 * 对联系记录表格进行排序（带动画效果）
 * @param {boolean} withAnimation - 是否带动画效果
 */
function sortContactTable(withAnimation = false) {
    const tbody = document.querySelector('#contactTable tbody');
    const rows = Array.from(tbody.rows);
    
    if (rows.length <= 1) return; // 只有一行不需要排序
    
    // 记录每行的当前索引和时间排序值
    const rowData = rows.map((row, index) => {
        const timeInput = row.querySelector('.contact-time-input');
        const timeValue = timeInput ? timeInput.value : '';
        return {
            row: row,
            oldIndex: index,
            sortValue: getContactTimeSortValue(timeValue)
        };
    });
    
    // 按排序值排序（保留原数组引用用于动画）
    const sortedData = [...rowData].sort((a, b) => a.sortValue - b.sortValue);
    
    // 计算每行的新位置
    const newPositions = {};
    sortedData.forEach((data, newIndex) => {
        newPositions[data.oldIndex] = newIndex;
    });
    
    if (withAnimation) {
        // 带动画效果
        animateContactTableSort(rowData, newPositions, sortedData, tbody);
    } else {
        // 无动画，直接重新排序
        tbody.innerHTML = '';
        sortedData.forEach(data => {
            tbody.appendChild(data.row);
        });
        // 更新序号
        updateContactRowNumbers();
    }
}

/**
 * 联系记录表格排序动画
 * @param {Object[]} rowData - 原始数据数组
 * @param {Object} newPositions - 新位置映射 {oldIndex: newIndex}
 * @param {Object[]} sortedData - 排序后的数据数组
 * @param {HTMLTableSectionElement} tbody - 表格tbody
 */
function animateContactTableSort(rowData, newPositions, sortedData, tbody) {
    // 计算每行的高度
    const rowHeight = rowData[0].row.offsetHeight;
    
    // 给需要移动的行设置transform
    rowData.forEach((data) => {
        const newIndex = newPositions[data.oldIndex];
        if (data.oldIndex !== newIndex) {
            data.row.classList.add('sorting-animate');
            const distance = (newIndex - data.oldIndex) * rowHeight;
            data.row.style.transform = `translateY(${distance}px)`;
        }
    });
    
    // 等待动画完成后重新排列DOM
    setTimeout(() => {
        // 清除所有transform样式和动画类
        sortedData.forEach(data => {
            data.row.style.transform = '';
            data.row.classList.remove('sorting-animate');
        });
        
        // 按正确顺序重新插入DOM
        tbody.innerHTML = '';
        sortedData.forEach(data => {
            tbody.appendChild(data.row);
        });
        
        // 更新序号
        updateContactRowNumbers();
    }, 350);
}

/**
 * 更新联系记录的行序号
 */
function updateContactRowNumbers() {
    const tbody = document.querySelector('#contactTable tbody');
    Array.from(tbody.rows).forEach((row, index) => {
        row.cells[0].textContent = index + 1;
    });
}

function removeContactRow(btn) {
    const tbody = document.querySelector('#contactTable tbody');
    if (tbody.rows.length > 1) {
        btn.closest('tr').remove();
        Array.from(tbody.rows).forEach((row, index) => {
            row.cells[0].textContent = index + 1;
        });
        markModified();
    } else {
        // 只剩最后一行，清空内容
        const row = btn.closest('tr');
        row.querySelectorAll('input, select').forEach(el => {
            if (el.tagName === 'SELECT') el.selectedIndex = 0;
            else el.value = '';
        });
        // 重置事由单元格为普通输入框（移除可能的时间戳包装器）
        const reasonCell = row.querySelector('.reason-cell');
        if (reasonCell) {
            reasonCell.innerHTML = `<input type="text" class="table-input" style="text-align: left;" placeholder="事由..." onchange="markModified()">`;
        }
        markModified();
    }
}

function initMultiSelects() {
    ['handoverFrom', 'handoverTo', 'auditor'].forEach(id => {
        const dropdown = document.querySelector(`#${id} .multi-select-dropdown`);
        dropdown.innerHTML = staffList.map(name => `
            <div class="multi-select-item" data-value="${name}" onclick="toggleItem('${id}', '${name}')">
                <input type="checkbox"> <span>${name}</span>
            </div>
        `).join('');
    });
}

function initDateDisplay() {
    // 根据时间规则设置日志日期（8点前用昨天的）
    const logDate = getLogDate();
    document.getElementById('logDate').value = logDate;
    
    // 审核日期为日志日期的第二天
    const auditDate = new Date(logDate);
    auditDate.setDate(auditDate.getDate() + 1);
    document.getElementById('auditDate').value = getDateString(auditDate);
    
    updateDateWarning();
}

function getLocalDateString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getDateString(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startClock() {
    function update() {
        const now = new Date();
        // 英文格式：Fri, Apr 11 2026 • 20:30:45
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const day = days[now.getDay()];
        const month = months[now.getMonth()];
        const date = now.getDate();
        const year = now.getFullYear();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        
        // 使用闪烁的冒号分隔符
        const timeStr = `${day}, ${month} ${date} ${year} <span class="time-separator">•</span> ${hours}<span class="time-separator">:</span>${minutes}<span class="time-separator">:</span>${seconds}`;
        document.getElementById('currentTime').innerHTML = timeStr;
    }
    update();
    setInterval(update, 1000);
}

// ============ 日期检查与自动切换 ============
/**
 * 获取当前应该使用的日志日期
 * 规则：早上8点前使用昨天的日志，8点后使用今天的日志
 */

function getLogDate() {
    const now = new Date();
    // if (now.getHours() < 9 || (now.getHours() === 9 && now.getMinutes() < 58)) {
    if (now.getHours() < 8) {
        // 8点前，使用昨天的日期
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        return getDateString(yesterday);
    }
    return getLocalDateString();
}

/**
 * 启动日期检查定时器，每分钟检查一次
 */
function startDateCheck() {
    dateCheckTimer = setInterval(() => {
        checkDateChange();
    }, 60000);  // 每分钟检查一次
}

/**
 * 检查日期是否发生变化，如变化则弹出提示
 */
function checkDateChange() {
    // 历史模式不检查
    if (isHistoryMode) return;
    // 用户选择跳过检查
    if (skipDateCheck) return;
    // 当前日志日期未初始化
    if (!currentLogDate) return;

    const newLogDate = getLogDate();
    if (newLogDate !== currentLogDate) {
        // 日期发生变化，弹出提示
        showDateChangePrompt(newLogDate);
    }
}

/**
 * 显示日期变更提示框
 */
function showDateChangePrompt(newDate) {
    // 创建自定义模态框
    const modalHtml = `
        <div class="modal-overlay show" id="dateChangeModal" style="z-index: 10000;">
            <div class="modal" style="max-width: 480px;">
                <div class="modal-header" style="background: linear-gradient(135deg, #1D324F 0%, #262626 100%);">
                    <h3 style="color: white;">📅 日期变更提示</h3>
                </div>
                <div class="modal-body" style="padding: 24px;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <div style="font-size: 48px; color: #D4A373; margin-bottom: 10px;">🌅</div>
                        <p style="font-size: 15px; color: var(--text-primary); line-height: 1.8;">
                            检测到日期已变更
                        </p>
                        <p style="font-size: 16px; color: var(--text-primary); margin-top: 10px;">
                            当前日期：<strong id="currentDateDisplay" style="color: #1D324F; font-size: 18px;">${getLogDate()}</strong>
                        </p>
                    </div>
                    <div style="background: #F8FAF8; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                        <p style="font-size: 14px; color: var(--text-secondary); margin: 0;">
                            ⚠️ <strong>切换之前请确认接班人已到现场！</strong>
                        </p>
                    </div>
                    <p style="font-size: 13px; color: var(--text-light); text-align: center;">
                        选择"切换"将保存当前日志并创建新日志<br>
                        选择"继续"将继续使用当前日志
                    </p>
                </div>
                <div class="modal-footer" style="justify-content: center; gap: 16px;">
                    <button class="btn btn-primary" onclick="handleDateChangeSwitch()">✅ 切换到当前日期日志</button>
                    <button class="btn btn-secondary" onclick="handleDateChangeContinue()">⏳ 继续当前日志</button>
                </div>
            </div>
        </div>
    `;
    
    // 添加到页面
    const existingModal = document.getElementById('dateChangeModal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // 启动日期实时更新定时器
    dateChangeUpdateTimer = setInterval(() => {
        const dateDisplay = document.getElementById('currentDateDisplay');
        if (dateDisplay) {
            dateDisplay.textContent = getLogDate();
        }
    }, 1000);
    
    // 点击背景不关闭（强制用户做出选择）
    document.getElementById('dateChangeModal').addEventListener('click', (e) => {
        if (e.target.id === 'dateChangeModal') {
            e.stopPropagation();
        }
    });
}

/**
 * 处理用户选择切换到新日志
 */
async function handleDateChangeSwitch() {
    // 停止日期更新定时器
    if (dateChangeUpdateTimer) {
        clearInterval(dateChangeUpdateTimer);
        dateChangeUpdateTimer = null;
    }
    
    // 关闭模态框
    document.getElementById('dateChangeModal').remove();
    
    // 点击时重新计算当前应该使用的日期
    const actualNewDate = getLogDate();
    
    try {
        // 保存当前日志
        if (isModified) {
            const data = collectData();
            await fetch(`/api/log/${data['日期']}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            isModified = false;
        }
        
        // 获取前一天的接班人信息（用于填入新日志的交班人）
        const prevHandover = await getPreviousDayHandover(currentLogDate);
        
        // 切换到新日志（使用点击时重新计算的日期）
        currentLogDate = actualNewDate;
        document.getElementById('logDate').value = actualNewDate;
        
        // 加载新日志（可能是空白模板）
        await loadLog(actualNewDate);
        
        // 如果有前一天的接班人信息，自动填入为交班人
        if (prevHandover && prevHandover.length > 0) {
            setMultiSelectValues('handoverFrom', prevHandover);
            markModified();
        }
        
        // 更新审核日期为新日志的第二天
        const auditDate = new Date(actualNewDate);
        auditDate.setDate(auditDate.getDate() + 1);
        document.getElementById('auditDate').value = getDateString(auditDate);
        
        updateDateWarning();
        
        // 显示成功提示
        showToast('✅ 已切换到 ' + actualNewDate + ' 的日志');
        
    } catch (e) {
        alert('切换日志失败：' + e.message);
    }
}

/**
 * 处理用户选择继续使用当前日志
 */
function handleDateChangeContinue() {
    // 停止日期更新定时器
    if (dateChangeUpdateTimer) {
        clearInterval(dateChangeUpdateTimer);
        dateChangeUpdateTimer = null;
    }
    
    // 关闭模态框
    document.getElementById('dateChangeModal').remove();
    
    // 设置跳过检查标志
    skipDateCheck = true;
    
    // 更新日期警告显示
    updateDateWarning();
    
    showToast('ℹ️ 继续使用当前日志');
}

/**
 * 获取前一天的接班人名单
 */
async function getPreviousDayHandover(dateStr) {
    try {
        const res = await fetch(`/api/log/${dateStr}`);
        const data = await res.json();
        
        // 返回接班人名单
        const handoverTo = data['接班人'] || [];
        // 过滤出有效的人员名单
        return handoverTo.filter(name => staffList.includes(name));
    } catch (e) {
        console.error('获取前一天接班人失败:', e);
        return [];
    }
}

/**
 * 显示toast提示
 */
function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        background: #1B4332;
        color: white;
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 14px;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        animation: fadeInUp 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'fadeOutDown 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// 添加toast动画样式
const toastStyle = document.createElement('style');
toastStyle.textContent = `
    @keyframes fadeInUp {
        from { opacity: 0; transform: translateX(-50%) translateY(20px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
    @keyframes fadeOutDown {
        from { opacity: 1; transform: translateX(-50%) translateY(0); }
        to { opacity: 0; transform: translateX(-50%) translateY(20px); }
    }
`;
document.head.appendChild(toastStyle);

// ============ 图片上传功能 ============
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * 处理图片上传
 * @param {HTMLInputElement} input - file input元素
 * @param {string} containerId - 缩略图容器ID
 * @param {string} title - 图片标题（用于提示）
 */
function handleImageUpload(input, containerId, title) {
    const files = input.files;
    if (!files || files.length === 0) return;
    
    const container = document.getElementById(containerId);
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // 验证文件类型
        if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
            alert(`不支持的图片格式: ${file.name}\n仅支持 JPG, PNG, GIF, WEBP 格式`);
            continue;
        }
        
        // 验证文件大小
        if (file.size > MAX_IMAGE_SIZE) {
            alert(`图片过大: ${file.name}\n最大允许 5MB`);
            continue;
        }
        
        // 读取并转换为BASE64
        const reader = new FileReader();
        reader.onload = function(e) {
            addImageThumbnail(container, e.target.result, title);
            markModified();
        };
        reader.readAsDataURL(file);
    }
    
    // 清空input，允许重复选择同一文件
    input.value = '';
}

/**
 * 添加图片缩略图
 * @param {HTMLElement} container - 缩略图容器
 * @param {string} base64Data - BASE64图片数据
 * @param {string} title - 图片标题
 */
function addImageThumbnail(container, base64Data, title) {
    const wrapper = document.createElement('div');
    wrapper.className = 'image-thumbnail-wrapper';
    wrapper.dataset.image = base64Data;
    
    const img = document.createElement('img');
    img.src = base64Data;
    img.alt = title;
    wrapper.appendChild(img);
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'image-thumbnail-delete';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = '删除图片';
    deleteBtn.onclick = function() {
        if (confirm('确定删除这张图片吗？')) {
            wrapper.remove();
            markModified();
        }
    };
    wrapper.appendChild(deleteBtn);
    
    container.appendChild(wrapper);
}

/**
 * 获取容器中的所有图片BASE64数据
 * @param {string} containerId - 缩略图容器ID
 * @returns {string[]} BASE64图片数组
 */
function getContainerImages(containerId) {
    const container = document.getElementById(containerId);
    const wrappers = container.querySelectorAll('.image-thumbnail-wrapper');
    const images = [];
    wrappers.forEach(wrapper => {
        images.push(wrapper.dataset.image);
    });
    return images;
}

/**
 * 设置容器中的图片
 * @param {string} containerId - 缩略图容器ID
 * @param {string[]} images - BASE64图片数组
 * @param {string} title - 图片标题
 */
function setContainerImages(containerId, images, title) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    if (images && images.length > 0) {
        images.forEach(imgData => {
            addImageThumbnail(container, imgData, title);
        });
    }
}

// ============ 多选下拉框 ============
function toggleDropdown(id) {
    const dropdown = document.querySelector(`#${id} .multi-select-dropdown`);
    const trigger = document.querySelector(`#${id} .multi-select-trigger`);
    const multiSelect = document.getElementById(id);
    const parentCard = multiSelect.closest('.card');
    const isOpen = dropdown.classList.contains('show');

    // 关闭所有下拉菜单，并移除所有状态
    document.querySelectorAll('.multi-select-dropdown').forEach(d => d.classList.remove('show'));
    document.querySelectorAll('.multi-select-trigger').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.card').forEach(c => c.classList.remove('dropdown-active'));

    if (!isOpen) {
        dropdown.classList.add('show');
        trigger.classList.add('active');
        // 给所在卡片提升层级
        if (parentCard) {
            parentCard.classList.add('dropdown-active');
        }
    }
}

function toggleItem(id, value) {
    const item = document.querySelector(`#${id} .multi-select-item[data-value="${value}"]`);
    const checkbox = item.querySelector('input[type="checkbox"]');
    checkbox.checked = !checkbox.checked;
    item.classList.toggle('selected', checkbox.checked);
    updateMultiSelectDisplay(id);
    markModified();
}

function updateMultiSelectDisplay(id) {
    const trigger = document.querySelector(`#${id} .multi-select-trigger`);
    const selected = [];
    document.querySelectorAll(`#${id} .multi-select-item.selected`).forEach(item => {
        selected.push(item.dataset.value);
    });
    const span = trigger.querySelector('span:first-child');
    if (selected.length === 0) {
        span.textContent = '请选择';
        span.className = 'placeholder';
    } else {
        span.textContent = selected.join(', ');
        span.className = '';
    }
}

function getMultiSelectValues(id) {
    const values = [];
    document.querySelectorAll(`#${id} .multi-select-item.selected`).forEach(item => {
        values.push(item.dataset.value);
    });
    return values;
}

function setMultiSelectValues(id, values) {
    const dropdown = document.querySelector(`#${id} .multi-select-dropdown`);
    
    // 遍历所有现有选项，设置选中状态
    document.querySelectorAll(`#${id} .multi-select-item`).forEach(item => {
        const isSelected = values.includes(item.dataset.value);
        item.classList.toggle('selected', isSelected);
        item.querySelector('input[type="checkbox"]').checked = isSelected;
    });
    
    // 检查是否有值不在当前选项中（如离职人员）
    // 这些值需要动态添加到下拉框中，以保留历史数据
    const existingValues = Array.from(
        document.querySelectorAll(`#${id} .multi-select-item`)
    ).map(item => item.dataset.value);
    
    values.forEach(val => {
        if (val && !existingValues.includes(val)) {
            // 创建新的选项元素
            const newItem = document.createElement('div');
            newItem.className = 'multi-select-item selected';
            newItem.dataset.value = val;
            newItem.setAttribute('onclick', `toggleItem('${id}', '${val}')`);
            newItem.innerHTML = `<input type="checkbox" checked> <span>${val}</span>`;
            dropdown.appendChild(newItem);
        }
    });
    
    updateMultiSelectDisplay(id);
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.multi-select')) {
        document.querySelectorAll('.multi-select-dropdown').forEach(d => d.classList.remove('show'));
        document.querySelectorAll('.multi-select-trigger').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.card').forEach(c => c.classList.remove('dropdown-active'));
    }
});

// ============ 数据收集 ============
function collectData() {
    const equipmentData = {};
    document.querySelectorAll('#equipmentTable .table-select').forEach(select => {
        const eq = select.dataset.equipment;
        const slot = select.dataset.slot;
        if (!equipmentData[eq]) equipmentData[eq] = {};
        equipmentData[eq][slot] = select.value;
    });

    const contactRecords = [];
    document.querySelectorAll('#contactTable tbody tr').forEach(tr => {
        // 获取时间输入框
        const timeInput = tr.querySelector('.contact-time-input');
        const time = timeInput ? timeInput.value : '';
        
        // 获取所属系统和类型下拉框
        const selects = tr.querySelectorAll('.table-select');
        const system = selects[0] ? selects[0].value : '';
        const type = selects[1] ? selects[1].value : '';
        
        // 获取事由内容（处理两种类型的输入框）
        const reasonCell = tr.querySelector('.reason-cell');
        let content = '';
        if (reasonCell) {
            const wrapperInput = reasonCell.querySelector('.reason-input-with-timestamp');
            const normalInput = reasonCell.querySelector('.table-input');
            
            if (wrapperInput) {
                // 带时间戳包装器的情况：需要组合时间戳和事由内容
                const timestampEl = reasonCell.querySelector('.reason-timestamp');
                const timestamp = timestampEl ? timestampEl.textContent : '';
                const reasonText = wrapperInput.value || '';
                content = reasonText ? `${timestamp} ${reasonText}` : timestamp;
            } else if (normalInput) {
                // 普通输入框（历史日志模式或非凌晨时段）
                content = normalInput.value || '';
            }
        }
        
        if (time || content) {
            contactRecords.push({ '时间': time, '所属系统': system, '类型': type, '内容': content });
        }
    });

    return {
        '日期': document.getElementById('logDate').value,
        '交班人': getMultiSelectValues('handoverFrom'),
        '接班人': getMultiSelectValues('handoverTo'),
        '交接时间从': document.getElementById('timeFrom').value,
        '交接时间到': document.getElementById('timeTo').value,
        '计划停机': document.querySelector('input[name="planShutdown"]:checked').value,
        '计划停机详情': document.getElementById('planDetail').value,
        '设备故障': document.querySelector('input[name="equipmentFault"]:checked').value,
        '设备故障详情': document.getElementById('faultDetail').value,
        '设备监控状态': equipmentData,
        '异常记录': [],
        '监控故障描述': document.getElementById('monitorNote').value,
        '监控故障图片': getContainerImages('monitorImagesContainer'),
        '联系记录': contactRecords,
        '应急情况': document.querySelector('input[name="emergency"]:checked').value,
        '电话通报机坪管制': document.getElementById('emergencyReport').checked,
        '应急措施': document.getElementById('emergencyMeasures').value,
        '后续通报': document.getElementById('emergencyReportTo').value,
        '接到通报': document.getElementById('receivedReport').checked,
        '其他情况': document.querySelector('input[name="otherEmergency"]:checked').value,
        '其他情况详情': document.getElementById('otherDetail').value,
        '其他故障': document.getElementById('generalNote').value,
        '其他故障图片': getContainerImages('generalImagesContainer'),
        '故障处置记录': document.getElementById('faultRecord').value,
        '审核人': getMultiSelectValues('auditor'),
        '审核日期': document.getElementById('auditDate').value
    };
}

function loadData(data) {
    const dateStr = data['日期'] || getLocalDateString();
    document.getElementById('logDate').value = dateStr;
    setMultiSelectValues('handoverFrom', data['交班人'] || []);
    setMultiSelectValues('handoverTo', data['接班人'] || []);
    document.getElementById('timeFrom').value = data['交接时间从'] || '00:00';
    document.getElementById('timeTo').value = data['交接时间到'] || '00:00';
    
    const planVal = data['计划停机'] || '无';
    const planRadio = document.querySelector(`input[name="planShutdown"][value="${planVal}"]`);
    if (planRadio) planRadio.checked = true;
    document.getElementById('planDetail').value = data['计划停机详情'] || '';
    
    const faultVal = data['设备故障'] || '无';
    const faultRadio = document.querySelector(`input[name="equipmentFault"][value="${faultVal}"]`);
    if (faultRadio) faultRadio.checked = true;
    document.getElementById('faultDetail').value = data['设备故障详情'] || '';
    
    const eqStatus = data['设备监控状态'] || {};
    document.querySelectorAll('#equipmentTable .table-select').forEach(select => {
        const eq = select.dataset.equipment;
        const slot = select.dataset.slot;
        select.value = (eqStatus[eq] && eqStatus[eq][slot]) || '正常';
    });
    
    document.getElementById('monitorNote').value = data['监控故障描述'] || '';
    
    // 加载监控故障图片
    setContainerImages('monitorImagesContainer', data['监控故障图片'] || [], '监控故障图片');
    
    const tbody = document.querySelector('#contactTable tbody');
    tbody.innerHTML = '';
    const contactRecords = data['联系记录'] || [];
    if (contactRecords.length > 0) {
        contactRecords.forEach(record => {
            const tr = document.createElement('tr');
            const rowCount = tbody.rows.length + 1;
            const recordTime = record['时间'] || '';
            const recordContent = record['内容'] || '';
            const isEarlyMorning = isEarlyMorningTime(recordTime);
            
            // 构建事由单元格内容
            let reasonCellHtml;
            if (isEarlyMorning && !isHistoryMode) {
                // 当天日志模式，凌晨时段：使用时间戳包装器
                const timestamp = calculateTimestampDate();
                const cleanReason = removeTimestamp(recordContent);
                reasonCellHtml = `
                    <td class="reason-cell">
                        <div class="reason-input-wrapper">
                            <span class="reason-timestamp">${timestamp}</span>
                            <input type="text" class="reason-input-with-timestamp" value="${cleanReason}" placeholder="事由..." onchange="markModified()">
                        </div>
                    </td>
                `;
            } else {
                // 历史日志模式或非凌晨时段：普通输入框（时间戳已在数据中）
                reasonCellHtml = `
                    <td class="reason-cell"><input type="text" class="table-input" style="text-align: left;" value="${recordContent}" placeholder="事由..." onchange="markModified()"></td>
                `;
            }
            
            tr.innerHTML = `
                <td>${rowCount}</td>
                <td><input type="time" class="table-input contact-time-input" value="${recordTime}" onchange="onContactTimeChange(this)"></td>
                <td>
                    <select class="table-select" onchange="markModified()">
                        <option value="" disabled ${!record['所属系统'] ? 'selected' : ''}>请选择...</option>
                        ${config.contact_systems.map(s => `<option value="${s}" ${record['所属系统'] === s ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                </td>
                <td>
                    <select class="table-select" onchange="markModified()">
                        <option value="" disabled ${!record['类型'] ? 'selected' : ''}>请选择...</option>
                        <option value="接到报修" ${record['类型'] === '接到报修' ? 'selected' : ''}>接到报修</option>
                        <option value="处理结果" ${record['类型'] === '处理结果' ? 'selected' : ''}>处理结果</option>
                    </select>
                </td>
                ${reasonCellHtml}
                <td><button class="btn btn-danger" onclick="removeContactRow(this)">×</button></td>
            `;
            
            // 给行添加焦点事件监听
            tr.addEventListener('focusin', () => {
                currentEditingContactRow = tr;
            });
            tr.addEventListener('focusout', (e) => {
                setTimeout(() => {
                    if (currentEditingContactRow === tr) {
                        if (pendingContactSort) {
                            sortContactTable(true);
                            pendingContactSort = false;
                        }
                        currentEditingContactRow = null;
                    }
                }, 50);
            });
            
            tbody.appendChild(tr);
        });
    } else {
        addContactRow();
    }
    
    // 加载完成后对联系记录进行排序（无动画）
    sortContactTable(false);
    
    const emergVal = data['应急情况'] || '无';
    const emergRadio = document.querySelector(`input[name="emergency"][value="${emergVal}"]`);
    if (emergRadio) emergRadio.checked = true;
    document.getElementById('emergencyReport').checked = data['电话通报机坪管制'] || false;
    document.getElementById('emergencyMeasures').value = data['应急措施'] || '';
    document.getElementById('emergencyReportTo').value = data['后续通报'] || '';
    document.getElementById('receivedReport').checked = data['接到通报'] || false;
    
    const otherVal = data['其他情况'] || '无';
    const otherRadio = document.querySelector(`input[name="otherEmergency"][value="${otherVal}"]`);
    if (otherRadio) otherRadio.checked = true;
    document.getElementById('otherDetail').value = data['其他情况详情'] || '';
    
    document.getElementById('generalNote').value = data['其他故障'] || '';
    
    // 加载其他故障图片
    setContainerImages('generalImagesContainer', data['其他故障图片'] || [], '其他故障图片');
    
    document.getElementById('faultRecord').value = data['故障处置记录'] || '';
    setMultiSelectValues('auditor', data['审核人'] || []);
    
    if (data['审核日期'] && /^\d{4}-\d{2}-\d{2}$/.test(data['审核日期'])) {
        document.getElementById('auditDate').value = data['审核日期'];
    } else {
        const logDate = new Date(dateStr);
        logDate.setDate(logDate.getDate() + 1);
        document.getElementById('auditDate').value = getDateString(logDate);
    }
    
    updateDateWarning();
}

// ============ 保存/加载 ============
function validateBeforeSave() {
    const handoverFrom = getMultiSelectValues('handoverFrom');
    const handoverTo = getMultiSelectValues('handoverTo');
    const auditor = getMultiSelectValues('auditor');
    const timeFrom = document.getElementById('timeFrom').value;
    const timeTo = document.getElementById('timeTo').value;
    
    const contactRecords = [];
    document.querySelectorAll('#contactTable tbody tr').forEach(tr => {
        // 获取时间输入框
        const timeInput = tr.querySelector('.contact-time-input');
        const time = timeInput ? timeInput.value : '';
        
        // 获取所属系统和类型下拉框
        const selects = tr.querySelectorAll('.table-select');
        const system = selects[0] ? selects[0].value : '';
        const type = selects[1] ? selects[1].value : '';
        
        // 获取事由内容
        const reasonCell = tr.querySelector('.reason-cell');
        let content = '';
        if (reasonCell) {
            const wrapperInput = reasonCell.querySelector('.reason-input-with-timestamp');
            const normalInput = reasonCell.querySelector('.table-input');
            
            if (wrapperInput) {
                const timestampEl = reasonCell.querySelector('.reason-timestamp');
                const timestamp = timestampEl ? timestampEl.textContent : '';
                const reasonText = wrapperInput.value || '';
                content = reasonText ? `${timestamp} ${reasonText}` : timestamp;
            } else if (normalInput) {
                content = normalInput.value || '';
            }
        }
        
        if (time || content) {
            contactRecords.push({ '时间': time, '所属系统': system, '类型': type, '内容': content });
        }
    });

    let warnings = [];
    if (handoverFrom.length === 0) warnings.push('未填写交班人');
    if (handoverTo.length === 0) warnings.push('未填写接班人');
    if (auditor.length === 0) warnings.push('未填写审核人');
    if (timeFrom === '00:00' && timeTo === '00:00') warnings.push('交接时间未填写 (均为 00:00)');

    let repairs = [];
    contactRecords.forEach(record => {
        if (record['类型'] === '接到报修') {
            repairs.push({ system: record['所属系统'], closed: false });
        } else if (record['类型'] === '处理结果') {
            for (let r of repairs) {
                if (!r.closed && r.system === record['所属系统']) {
                    r.closed = true;
                    break;
                }
            }
        }
    });
    let unclosed = repairs.filter(r => !r.closed);
    if (unclosed.length > 0) {
        warnings.push(`联系记录中有 ${unclosed.length} 条报修未闭环`);
    }

    if (warnings.length > 0) {
        showSaveWarningModal(warnings);
    }
    return true;
}

/**
 * 显示保存提示模态框
 * @param {string[]} warnings - 警告列表
 */
function showSaveWarningModal(warnings) {
    const listEl = document.getElementById('saveWarningList');
    listEl.innerHTML = warnings.map(w => `<div class="save-warning-item">${w}</div>`).join('');
    document.getElementById('saveWarningModal').classList.add('show');
}

async function saveLog() {
    validateBeforeSave();
    const data = collectData();
    try {
        const res = await fetch(`/api/log/${data['日期']}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.status === 'success') {
            showSaveStatus('saved');
            isModified = false;
        } else {
            alert('保存失败：' + (result.message || '未知错误'));
        }
    } catch (e) {
        alert('保存失败：' + e.message);
    }
}

async function loadTodayLog() {
    // 根据时间规则决定加载哪天的日志（8点前用昨天的）
    const logDate = getLogDate();
    document.getElementById('logDate').value = logDate;
    await loadLog(logDate);
    
    // 启动时检查是否需要自动填充"交班人"
    await checkAndFillHandoverFrom(logDate);
}

/**
 * 检查并自动填充"交班人"
 * 规则：如果当天日志不存在或"交班人"为空，则获取昨天日志的"接班人"自动填入
 * 这样即使程序关闭后第二天再打开，也能正确填充交接信息
 */
async function checkAndFillHandoverFrom(currentDate) {
    // 历史模式不处理
    if (isHistoryMode) return;
    
    // 获取当前"交班人"
    const currentHandoverFrom = getMultiSelectValues('handoverFrom');
    
    // 如果"交班人"已有内容，不需要处理
    if (currentHandoverFrom.length > 0) return;
    
    // 计算前一天的日期（需要获取前一天日志的"接班人"）
    const prevDate = getDateString(new Date(new Date(currentDate).setDate(new Date(currentDate).getDate() - 1)));
    
    // 获取前一天日志的"接班人"
    const prevHandoverTo = await getPreviousDayHandover(prevDate);
    
    // 如果有数据，自动填入
    if (prevHandoverTo && prevHandoverTo.length > 0) {
        setMultiSelectValues('handoverFrom', prevHandoverTo);
        markModified();
        showToast('✅ 已自动填入昨天的接班人为交班人');
    }
}

async function loadLog(dateStr) {
    try {
        const res = await fetch(`/api/log/${dateStr}`);
        const data = await res.json();
        loadData(data);
        isModified = false;
        showSaveStatus('saved');
        
        // 更新当前日志日期（非历史模式）
        if (!isHistoryMode) {
            currentLogDate = dateStr;
        }
    } catch (e) {
        console.error('加载日志失败:', e);
    }
}

function updateDateWarning() {
    // 历史模式不显示日期警告
    if (isHistoryMode) {
        document.getElementById('dateWarning').classList.add('hidden');
        return;
    }
    
    // 使用getLogDate来判断当前应该使用的日志日期
    const expectedDate = getLogDate();
    const selected = document.getElementById('logDate').value;
    const warning = document.getElementById('dateWarning');
    
    if (selected !== expectedDate) {
        warning.classList.remove('hidden');
        // 如果用户选择继续使用当前日志，显示可点击切换的提示
        if (skipDateCheck) {
            warning.innerHTML = `<span style="color: #D4A373; cursor: pointer;">⚠️ 已进入新值班周期，当前使用 ${selected} 日志（点击切换）</span>`;
        } else {
            warning.innerHTML = `⚠️ 当前日志日期与值班日期不一致`;
        }
    } else {
        warning.classList.add('hidden');
    }
}

async function switchToToday() {
    if (isModified) {
        if (!confirm('当前日志已修改，是否先保存？')) return;
        await saveLog();
    }
    // 使用getLogDate切换到正确的日志日期
    const logDate = getLogDate();
    document.getElementById('logDate').value = logDate;
    await loadLog(logDate);
    
    // 重置跳过检查标志（用户主动切换了）
    skipDateCheck = false;
    
    // 检查是否需要自动填充"交班人"
    await checkAndFillHandoverFrom(logDate);
    
    // 更新审核日期为新日志的第二天
    const auditDate = new Date(logDate);
    auditDate.setDate(auditDate.getDate() + 1);
    document.getElementById('auditDate').value = getDateString(auditDate);
    
    updateDateWarning();
    showToast('✅ 已切换到新日志');
}

// ============ 自动保存 ============
function startAutoSave() {
    autoSaveTimer = setInterval(async () => {
        if (isModified) {
            const data = collectData();
            try {
                await fetch(`/api/log/${data['日期']}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                showSaveStatus('saved');
                isModified = false;
                console.log('自动保存成功:', data['日期']);
            } catch (e) {
                console.error('自动保存失败:', e);
            }
        }
    }, 60000); // 每 1 分钟自动保存
}

function markModified() {
    isModified = true;
    showSaveStatus('saving');
}

function showSaveStatus(status) {
    const indicator = document.getElementById('saveIndicator');
    const pulse = indicator.querySelector('.pulse');
    const text = indicator.querySelector('span:last-child');
    if (status === 'saving') {
        indicator.className = 'save-indicator saving';
        pulse.className = 'pulse';
        text.textContent = '未保存';
    } else {
        indicator.className = 'save-indicator saved';
        pulse.className = 'pulse saved';
        text.textContent = '已保存';
    }
}

// ============ 字体设置 ============
function changeFont() {
    const font = document.getElementById('fontFamily').value;
    document.body.style.fontFamily = `'${font}', sans-serif`;
}

// ============ 局域网访问控制 ============
let lanAccessEnabled = false;
let isLocalAccess = true;  // 是否本机访问

async function loadLanAccessStatus() {
    try {
        const res = await fetch('/api/lan-status');
        const data = await res.json();
        lanAccessEnabled = data.enabled;
        isLocalAccess = data.is_local;  // 获取是否本机访问
        
        // 只有本机访问才显示局域网开关
        const lanToggleDiv = document.querySelector('.lan-toggle');
        if (lanToggleDiv) {
            lanToggleDiv.style.display = isLocalAccess ? 'flex' : 'none';
        }
        
        document.getElementById('lanAccessToggle').checked = lanAccessEnabled;
    } catch (e) {
        console.error('获取局域网状态失败:', e);
    }
}

async function toggleLanAccess(enabled) {
    try {
        const res = await fetch('/api/lan-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: enabled })
        });
        const data = await res.json();
        
        if (data.status === 'success') {
            lanAccessEnabled = enabled;
            if (enabled) {
                const protocol = data.protocol || 'https';
                showToast('✅ 局域网访问已开启，其他设备可通过 ' + protocol + '://' + data.lan_ip + ':5151 访问');
            } else {
                showToast('🔒 局域网访问已关闭，仅本机可访问');
            }
        } else {
            // 恢复开关状态
            document.getElementById('lanAccessToggle').checked = lanAccessEnabled;
            alert('设置失败：' + (data.message || '未知错误'));
        }
    } catch (e) {
        document.getElementById('lanAccessToggle').checked = lanAccessEnabled;
        alert('设置失败：' + e.message);
    }
}

// ============ 人员名单配置 ============
function openStaffConfig() {
    document.getElementById('staffModal').classList.add('show');
    renderStaffList();
}

function renderStaffList() {
    const container = document.getElementById('staffListContainer');
    container.innerHTML = staffList.map((name, i) => `
        <div class="staff-item">
            <span>${name}</span>
            <button class="remove-btn" onclick="removeStaff(${i})">&times;</button>
        </div>
    `).join('');
}

function addStaff() {
    const input = document.getElementById('newStaffName');
    const name = input.value.trim();
    
    // 验证1：空值检查
    if (!name) {
        alert('请输入人员姓名');
        return;
    }
    
    // 验证2：长度检查（2-10个字符）
    if (name.length < 2) {
        alert('姓名至少需要2个字符');
        return;
    }
    if (name.length > 10) {
        alert('姓名不能超过10个字符');
        return;
    }
    
    // 验证3：重复检查
    if (staffList.includes(name)) {
        alert('该人员已存在');
        return;
    }
    
    // 验证4：非法字符检查
    // 禁止：空格、HTML/XML特殊字符、JSON特殊字符、引号、斜杠等
    const illegalChars = /[<>\"\'\\\/\[\]\{\}\:\;\,\!\@\#\$\%\^\&\*\(\)\+\=\|\~\`\?\n\r\t]/;
    if (illegalChars.test(name)) {
        alert('姓名包含非法字符，请只使用中文或英文字母');
        return;
    }
    
    // 验证5：不能纯数字（避免混淆）
    if (/^\d+$/.test(name)) {
        alert('姓名不能为纯数字');
        return;
    }
    
    // 验证6：名字首尾不能有空格（已trim处理，这里检查中间是否有空格）
    if (name.includes(' ') || name.includes('　')) {  // 半角和全角空格
        alert('姓名中不能包含空格');
        return;
    }
    
    // 验证通过，添加到列表
    staffList.push(name);
    input.value = '';
    renderStaffList();
}

function removeStaff(index) {
    if (confirm(`确定要删除 "${staffList[index]}" 吗？`)) {
        staffList.splice(index, 1);
        renderStaffList();
    }
}

async function saveStaffConfig() {
    try {
        const res = await fetch('/api/staff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ staff_list: staffList })
        });
        const result = await res.json();
        
        if (result.status === 'success') {
            staffList = result.staff_list;
            initMultiSelects();
            alert('✅ 保存成功！');
            closeModal('staffModal');
        } else if (result.status === 'warning') {
            // 有部分验证失败，显示错误但保存了有效名字
            staffList = result.staff_list;
            renderStaffList();
            initMultiSelects();
            alert('⚠️ ' + result.message + '\n\n有效的人员已保存，请检查并修正错误后重新添加。');
        } else {
            alert('保存失败：未知错误');
        }
    } catch (e) {
        alert('保存失败：' + e.message);
    }
}

// ============ 批量导出 PDF ============
function batchExportPDF() {
    document.getElementById('pdfModal').classList.add('show');
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    document.getElementById('pdfStartDate').value = getDateString(weekAgo);
    document.getElementById('pdfEndDate').value = getDateString(today);
    document.getElementById('pdfProgress').style.display = 'none';
}

async function startBatchPDF() {
    const startDate = document.getElementById('pdfStartDate').value;
    const endDate = document.getElementById('pdfEndDate').value;
    
    if (!startDate || !endDate) {
        alert('请选择日期范围');
        return;
    }

    const progressDiv = document.getElementById('pdfProgress');
    const progressBar = document.getElementById('pdfProgressBar');
    const progressText = document.getElementById('pdfProgressText');
    progressDiv.style.display = 'block';
    
    const dates = [];
    let current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
        dates.push(getDateString(current));
        current.setDate(current.getDate() + 1);
    }

    let success = 0;
    let failed = 0;
    const failedReasons = []; // 记录失败原因
    // 使用 iframe 渲染 PDF 内容 - 这是 html2canvas 最可靠的方式
    const pdfIframe = document.getElementById('pdf-render-iframe');
    const pdfContainer = document.getElementById('pdf-render-container');

    for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        progressText.textContent = `正在导出 ${date} (${i + 1}/${dates.length})...`;
        progressBar.style.width = `${((i + 1) / dates.length) * 100}%`;
        
        try {
            const res = await fetch(`/api/pdf/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: date })
            });
            
            if (res.ok) {
                const result = await res.json();
                if (result.status === 'success') {
                    console.log(`开始生成 PDF: ${date}, HTML内容长度:`, result.html_content.length);
                    
                    // 方法1：使用 iframe 渲染（推荐，最可靠）
                    const iframeDoc = pdfIframe.contentDocument || pdfIframe.contentWindow.document;
                    iframeDoc.open();
                    iframeDoc.write(result.html_content);
                    iframeDoc.close();
                    
                    // 等待 iframe 内容渲染完成
                    await new Promise(r => setTimeout(r, 300));
                    
                    // 从 iframe 的 body 元素生成 PDF
                    const element = iframeDoc.body;
                    
                    const opt = {
                        margin: 10,
                        filename: `${date}.pdf`,
                        image: { type: 'jpeg', quality: 0.95 },
                        html2canvas: { 
                            scale: 2,
                            useCORS: true,
                            logging: false,
                            allowTaint: true,
                            scrollX: 0,
                            scrollY: 0
                        },
                        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
                    };
                    
                    // 生成 PDF blob 并上传到服务器保存
                    const pdfBlob = await html2pdf().set(opt).from(element).outputPdf('blob');
                    
                    // 创建 FormData 上传 PDF
                    const formData = new FormData();
                    formData.append('pdf', pdfBlob, `${date}.pdf`);
                    formData.append('date', date);
                    
                    const uploadRes = await fetch('/api/pdf/save', {
                        method: 'POST',
                        body: formData
                    });
                    
                    const uploadResult = await uploadRes.json();
                    if (uploadResult.status === 'success') {
                        console.log(`PDF 保存成功: ${date}`);
                        success++;
                    } else {
                        console.error(`保存 ${date} 失败:`, uploadResult.message);
                        failedReasons.push({ date: date, reason: uploadResult.message || '保存失败' });
                        failed++;
                    }
                } else {
                    console.error(`导出 ${date} 失败:`, result.message);
                    failedReasons.push({ date: date, reason: result.message || '日志不存在' });
                    failed++;
                }
            } else {
                // HTTP 错误状态码，尝试解析服务器返回的错误信息
                try {
                    const errorResult = await res.json();
                    failedReasons.push({ date: date, reason: errorResult.message || `服务器错误 (${res.status})` });
                } catch {
                    failedReasons.push({ date: date, reason: `请求失败 (${res.status})` });
                }
                failed++;
            }
        } catch (e) {
            console.error(`导出 ${date} 失败:`, e);
            failedReasons.push({ date: date, reason: e.message || '处理异常' });
            failed++;
        }
        await new Promise(r => setTimeout(r, 200));
    }

    // 清理 iframe
    const iframeDoc = pdfIframe.contentDocument || pdfIframe.contentWindow.document;
    iframeDoc.open();
    iframeDoc.write('');
    iframeDoc.close();
    
    progressText.textContent = `导出完成！成功：${success}，失败：${failed}`;
    showExportSuccessModal(success, failed, failedReasons);
}

/**
 * 显示导出成功模态框
 */
function showExportSuccessModal(success, failed, failedReasons) {
    document.getElementById('exportSuccessCount').textContent = success;
    document.getElementById('exportFailedCount').textContent = failed;

    // 显示失败原因列表
    const failedReasonsDiv = document.getElementById('exportFailedReasons');
    const failedListDiv = document.getElementById('exportFailedList');

    if (failed > 0 && failedReasons && failedReasons.length > 0) {
        failedListDiv.innerHTML = failedReasons.map(item =>
            `<div class="export-failed-item"><span class="date">${item.date}</span><span class="reason">— ${item.reason}</span></div>`
        ).join('');
        failedReasonsDiv.style.display = 'block';
    } else {
        failedReasonsDiv.style.display = 'none';
    }

    document.getElementById('exportSuccessModal').classList.add('show');
    closeModal('pdfModal');
}

// ============ 批量检查日志 ============
let currentCheckReportUrl = null;  // 保存当前检查报告的URL

function checkLogs() {
    document.getElementById('checkModal').classList.add('show');
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    document.getElementById('checkStartDate').value = getDateString(weekAgo);
    document.getElementById('checkEndDate').value = getDateString(today);
    document.getElementById('checkProgress').style.display = 'none';
    document.getElementById('checkResult').style.display = 'none';
    document.getElementById('openCheckReportBtn').style.display = 'none';  // 隐藏打开报告按钮
    currentCheckReportUrl = null;  // 清空报告URL
}

async function startCheckLogs() {
    const startDate = document.getElementById('checkStartDate').value;
    const endDate = document.getElementById('checkEndDate').value;
    
    if (!startDate || !endDate) {
        alert('请选择日期范围');
        return;
    }

    const progressDiv = document.getElementById('checkProgress');
    const progressBar = document.getElementById('checkProgressBar');
    const progressText = document.getElementById('checkProgressText');
    const openReportBtn = document.getElementById('openCheckReportBtn');
    
    progressDiv.style.display = 'block';
    progressText.textContent = '正在检查...';
    progressBar.style.width = '50%';
    openReportBtn.style.display = 'none';  // 检查过程中隐藏按钮

    try {
        const res = await fetch('/api/log/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start_date: startDate, end_date: endDate })
        });
        const result = await res.json();
        
        progressBar.style.width = '100%';
        progressText.textContent = '检查完成！';
        
        const resultDiv = document.getElementById('checkResult');
        const resultContent = document.getElementById('checkResultContent');
        resultDiv.style.display = 'block';
        
        // 保存报告URL，用于打开报告按钮
        if (result.report_filename) {
            currentCheckReportUrl = '/api/report/file/' + result.report_filename;
            openReportBtn.style.display = 'inline-block';  // 显示打开报告按钮
        }
        
        let text = `日志完整性检查结果：\n\n`;
        text += `检查日期范围：${result.start_date} 至 ${result.end_date}\n`;
        text += `检查时间：${result.check_time}\n\n`;
        
        if (result.missing_files.length > 0) {
            text += `【缺失的日志文件】\n`;
            result.missing_files.forEach(d => text += `• ${d}\n`);
            text += `\n`;
        }
        
        if (result.incomplete_logs.length > 0) {
            text += `【存在问题的日志】\n`;
            result.incomplete_logs.forEach(log => {
                text += `• ${log.date}${log.staff_info}\n`;
                log.issues.forEach(issue => text += `    - ${issue}\n`);
            });
            text += `\n`;
        }
        
        text += `【检查结果统计】\n`;
        text += `• 检查总天数：${result.total_checked} 天\n`;
        text += `• 完整日志：${result.complete_count} 天\n`;
        if (result.missing_count > 0) text += `• 缺失日志：${result.missing_count} 天\n`;
        if (result.incomplete_count > 0) text += `• 存在问题日志：${result.incomplete_count} 天\n`;
        
        if (result.missing_files.length === 0 && result.incomplete_logs.length === 0) {
            text += `\n🎉 恭喜！所有日志都完整且符合要求！`;
        }
        
        text += `\n\n💡 点击下方按钮可查看详细HTML报告`;
        
        resultContent.textContent = text;
    } catch (e) {
        alert('检查失败：' + e.message);
    }
}

function openCheckReport() {
    if (currentCheckReportUrl) {
        window.open(currentCheckReportUrl, '_blank');  // 在新标签页打开
    } else {
        alert('报告尚未生成，请先执行检查');
    }
}

// ============ 历史日志 ============
let allLogs = [];

async function openHistoryLog() {
    document.getElementById('historyModal').classList.add('show');
    const list = document.getElementById('historyList');
    list.innerHTML = '<p style="text-align: center; color: var(--text-light); padding: 40px;">加载中...</p>';
    
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    document.getElementById('historyDateJump').value = getDateString(yesterday);
    
    try {
        const res = await fetch('/api/logs/list');
        allLogs = await res.json();
        
        const years = [...new Set(allLogs.map(l => l.year))].sort().reverse();
        const months = [...new Set(allLogs.map(l => l.month))].sort().reverse();
        
        const yearSelect = document.getElementById('historyYearFilter');
        yearSelect.innerHTML = '<option value="">全部年份</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
        
        const monthSelect = document.getElementById('historyMonthFilter');
        monthSelect.innerHTML = '<option value="">全部月份</option>' + months.map(m => `<option value="${m}">${m}月</option>`).join('');
        
        filterHistoryList();
    } catch (e) {
        list.innerHTML = '<p style="text-align: center; color: var(--danger-color); padding: 40px;">加载失败</p>';
    }
}

function filterHistoryList() {
    const year = document.getElementById('historyYearFilter').value;
    const month = document.getElementById('historyMonthFilter').value;
    const today = getLocalDateString();
    
    let filtered = allLogs;
    if (year) filtered = filtered.filter(l => l.year === year);
    if (month) filtered = filtered.filter(l => l.month === month);
    
    filtered.sort((a, b) => b.date.localeCompare(a.date));
    
    const list = document.getElementById('historyList');
    if (filtered.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: var(--text-light); padding: 40px;">暂无匹配的日志</p>';
        return;
    }
    
    list.innerHTML = filtered.map(log => {
        const isToday = log.date === today;
        const style = isToday ? 'opacity: 0.5; pointer-events: none; background: #f9fafb;' : '';
        const title = isToday ? '📅 当天日志 (不可在此打开)' : `📄 ${log.date}`;
        return `
            <div class="staff-item" style="${style} cursor: pointer;" onclick="${isToday ? '' : `loadHistoryLog('${log.date}')`}">
                <span>${title}</span>
                <span style="color: var(--text-light); font-size: 12px;">${log.year}-${log.month}</span>
            </div>
        `;
    }).join('');
}

function jumpToDate() {
    const dateStr = document.getElementById('historyDateJump').value;
    if (!dateStr) {
        alert('请选择日期');
        return;
    }
    loadHistoryLog(dateStr);
}

function handleLocalFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            
            // 验证是否为有效的日志文件（检查必要字段）
            const requiredFields = ['日期', '交班人', '接班人'];
            const missingFields = requiredFields.filter(field => !(field in data));
            
            if (missingFields.length > 0) {
                alert('❌ 该文件不是有效的值班日志文件！\n\n缺少必要字段：' + missingFields.join(', ') + '\n\n请选择正确的日志文件（位于 Log_Stor 目录下的 .json 文件）');
                event.target.value = '';
                return;
            }
            
            // 验证日期格式
            if (!/^\d{4}-\d{2}-\d{2}$/.test(data['日期'])) {
                alert('❌ 日志文件日期格式不正确！\n\n请选择正确的日志文件。');
                event.target.value = '';
                return;
            }
            
            // 存储到 localStorage，在新标签页中读取
            localStorage.setItem('local_log_data', JSON.stringify(data));
            // 在新标签页打开
            const url = window.location.origin + window.location.pathname + '#local-file';
            window.open(url, '_blank');
            closeModal('historyModal');
        } catch (err) {
            alert('❌ 文件解析失败：' + err.message + '\n\n请确保选择的是有效的 JSON 格式日志文件。');
        }
    };
    reader.readAsText(file);
    // 重置 input 以便下次可以选择同一文件
    event.target.value = '';
}

function loadHistoryLog(dateStr) {
    const url = window.location.origin + window.location.pathname + '#' + dateStr;
    window.open(url, '_blank');
    closeModal('historyModal');
}

// ============ 报告生成功能 ============

// 台账报告URL（用于打开报告按钮）
let currentTaizhangReportUrl = null;

/**
 * 打开台账生成对话框
 */
async function openTaizhangDialog() {
    let yearOptions = '<option value="">加载中...</option>';
    
    const modalHtml = `
        <div class="modal-overlay" id="taizhangModal">
            <div class="modal" style="max-width: 480px;">
                <div class="modal-header">
                    <span>📊 生成台账</span>
                    <button class="modal-close" onclick="closeModal('taizhangModal')">✕</button>
                </div>
                <div class="modal-body">
                    <div class="form-row">
                        <label>选择年份：</label>
                        <select id="taizhangYear" class="form-control">
                            ${yearOptions}
                        </select>
                    </div>
                    <div class="form-row">
                        <label>报告类型：</label>
                        <select id="taizhangType" class="form-control" onchange="toggleHalfYearSelect()">
                            <option value="full">年报</option>
                            <option value="half">半年报</option>
                        </select>
                    </div>
                    <div class="form-row" id="halfYearRow" style="display: none;">
                        <label>半年期：</label>
                        <select id="taizhangHalf" class="form-control">
                            <option value="first_half">上半年（1-6月）</option>
                            <option value="second_half">下半年（7-12月）</option>
                        </select>
                    </div>
                    <div style="margin-top: 15px; color: var(--text-light); font-size: 13px;">
                        💡 仅显示有日志数据的年份
                    </div>
                    <!-- 进度显示 -->
                    <div id="taizhangProgress" style="margin-top: 16px; display: none;">
                        <div class="progress-bar-container">
                            <div class="progress-bar" id="taizhangProgressBar" style="width: 0;"></div>
                        </div>
                        <div class="progress-text" id="taizhangProgressText">准备生成...</div>
                    </div>
                    <!-- 结果显示 -->
                    <div id="taizhangResult" style="margin-top: 16px; display: none;">
                        <div class="check-result" id="taizhangResultContent" style="white-space: pre-wrap; font-size: 13px;"></div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('taizhangModal')">关闭</button>
                    <button class="btn btn-primary" onclick="generateTaizhang()">生成台账</button>
                    <button class="btn btn-success" id="openTaizhangReportBtn" style="display: none;" onclick="openTaizhangReport()">📄 打开台账报告</button>
                </div>
            </div>
        </div>
    `;
    
    // 移除旧的弹窗（如果存在）
    const oldModal = document.getElementById('taizhangModal');
    if (oldModal) oldModal.remove();
    
    // 添加到页面
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // 重置状态
    currentTaizhangReportUrl = null;
    document.getElementById('taizhangProgress').style.display = 'none';
    document.getElementById('taizhangResult').style.display = 'none';
    document.getElementById('openTaizhangReportBtn').style.display = 'none';
    
    // 显示弹窗
    setTimeout(() => {
        document.getElementById('taizhangModal').classList.add('show');
    }, 10);
    
    // 从后端获取可用的年份
    try {
        const res = await fetch('/api/logs/available-periods');
        const data = await res.json();
        
        const yearSelect = document.getElementById('taizhangYear');
        
        if (data.years && data.years.length > 0) {
            yearSelect.innerHTML = data.years.map(y => `<option value="${y}">${y}年</option>`).join('');
        } else {
            yearSelect.innerHTML = '<option value="">暂无数据</option>';
        }
    } catch (e) {
        console.error('获取可用年份失败:', e);
        document.getElementById('taizhangYear').innerHTML = '<option value="">加载失败</option>';
    }
}

/**
 * 切换半年期选择的显示/隐藏
 */
function toggleHalfYearSelect() {
    const typeSelect = document.getElementById('taizhangType');
    const halfYearRow = document.getElementById('halfYearRow');
    
    if (typeSelect.value === 'full') {
        halfYearRow.style.display = 'none';
    } else {
        halfYearRow.style.display = 'flex';
    }
}

/**
 * 生成年度或半年度故障台账
 */
async function generateTaizhang() {
    const year = parseInt(document.getElementById('taizhangYear').value);
    const typeValue = document.getElementById('taizhangType').value;
    
    // 确定最终的 period 值
    let period;
    if (typeValue === 'full') {
        period = 'full';
    } else {
        period = document.getElementById('taizhangHalf').value;
    }
    
    if (!year) {
        alert('请选择年份');
        return;
    }
    
    // 获取UI元素
    const progressDiv = document.getElementById('taizhangProgress');
    const progressBar = document.getElementById('taizhangProgressBar');
    const progressText = document.getElementById('taizhangProgressText');
    const resultDiv = document.getElementById('taizhangResult');
    const resultContent = document.getElementById('taizhangResultContent');
    const openReportBtn = document.getElementById('openTaizhangReportBtn');
    
    // 显示进度
    progressDiv.style.display = 'block';
    progressBar.style.width = '50%';
    resultDiv.style.display = 'none';
    openReportBtn.style.display = 'none';
    
    const periodText = period === 'full' ? '' : (period === 'first_half' ? '上半年' : '下半年');
    progressText.textContent = `正在生成${year}年${periodText}故障台账...`;
    
    try {
        const res = await fetch('/api/report/taizhang', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year, period })
        });
        const data = await res.json();
        
        progressBar.style.width = '100%';
        progressText.textContent = '生成完成！';
        resultDiv.style.display = 'block';
        
        if (data.status === 'success') {
            // 保存报告URL，用于打开报告按钮
            if (data.filename) {
                currentTaizhangReportUrl = '/api/report/file/' + data.filename;
                openReportBtn.style.display = 'inline-block';
            }
            
            // 显示结果信息
            let text = `✅ 台账生成成功！\n\n`;
            text += `年份：${data.year}年${periodText}\n`;
            text += `文件：${data.filename}\n`;
            text += `故障总数：${data.total_faults} 条\n\n`;
            text += `💡 点击下方按钮可在浏览器中查看详细HTML报告`;
            resultContent.textContent = text;
            resultContent.style.color = 'var(--success-color)';
        } else {
            let text = `❌ 生成台账失败\n\n`;
            text += `错误：${data.message || '未知错误'}`;
            resultContent.textContent = text;
            resultContent.style.color = 'var(--danger-color)';
        }
    } catch (e) {
        console.error('生成台账失败:', e);
        progressBar.style.width = '100%';
        progressText.textContent = '生成失败';
        resultDiv.style.display = 'block';
        resultContent.textContent = '❌ 生成台账失败，请检查服务是否正常运行';
        resultContent.style.color = 'var(--danger-color)';
    }
}

/**
 * 打开台账报告（在新标签页）
 */
function openTaizhangReport() {
    if (currentTaizhangReportUrl) {
        window.open(currentTaizhangReportUrl, '_blank');
    } else {
        alert('报告尚未生成，请先生成台账');
    }
}

/**
 * 打开月报生成对话框（动态加载有数据的年份和月份）
 */
async function openMonthlyReportDialog() {
    // 先获取可用的年份和月份
    let yearOptions = '<option value="">加载中...</option>';
    let monthOptions = '<option value="">请先选择年份</option>';
    
    const modalHtml = `
        <div class="modal-overlay" id="monthlyReportModal">
            <div class="modal" style="max-width: 480px;">
                <div class="modal-header">
                    <span>📋 月报管理</span>
                    <button class="modal-close" onclick="closeModal('monthlyReportModal')">✕</button>
                </div>
                <div class="modal-body">
                    <!-- 生成月报区域 -->
                    <div style="margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px dashed var(--border-color);">
                        <div style="font-size: 14px; font-weight: 500; margin-bottom: 12px; color: var(--text-primary);">📝 生成新月报</div>
                        <div class="form-row">
                            <label>选择年份：</label>
                            <select id="reportYear" class="form-control" onchange="updateMonthOptions()">
                                ${yearOptions}
                            </select>
                        </div>
                        <div class="form-row">
                            <label>选择月份：</label>
                            <select id="reportMonth" class="form-control">
                                ${monthOptions}
                            </select>
                        </div>
                    </div>
                    
                    <!-- 下载月报区域 -->
                    <div>
                        <div style="font-size: 14px; font-weight: 500; margin-bottom: 12px; color: var(--text-primary);">📥 下载已生成的月报</div>
                        <div id="existingReportsList" style="min-height: 60px;">
                            <p style="text-align: center; color: var(--text-light); padding: 20px;">加载中...</p>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('monthlyReportModal')">关闭</button>
                    <button class="btn btn-primary" onclick="generateMonthlyReport()">生成月报</button>
                </div>
            </div>
        </div>
    `;
    
    // 移除旧的弹窗（如果存在）
    const oldModal = document.getElementById('monthlyReportModal');
    if (oldModal) oldModal.remove();
    
    // 添加到页面
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // 显示弹窗
    setTimeout(() => {
        document.getElementById('monthlyReportModal').classList.add('show');
    }, 10);
    
    // 并行加载：可用年月 + 已有月报列表
    loadMonthlyReportData();
}

/**
 * 加载月报相关数据（可用年月 + 已有月报列表）
 */
async function loadMonthlyReportData() {
    // 加载可用年月
    try {
        const res = await fetch('/api/logs/available-periods');
        const data = await res.json();
        
        const yearSelect = document.getElementById('reportYear');
        const monthSelect = document.getElementById('reportMonth');
        
        if (data.years && data.years.length > 0) {
            yearSelect.innerHTML = data.years.map(y => `<option value="${y}">${y}年</option>`).join('');
            yearSelect.dataset.monthsData = JSON.stringify(data.months_by_year);
            updateMonthOptions();
        } else {
            yearSelect.innerHTML = '<option value="">暂无数据</option>';
            monthSelect.innerHTML = '<option value="">暂无数据</option>';
        }
    } catch (e) {
        console.error('获取可用年月失败:', e);
        document.getElementById('reportYear').innerHTML = '<option value="">加载失败</option>';
    }
    
    // 加载已有月报列表
    try {
        const res = await fetch('/api/report/monthly/list');
        const data = await res.json();
        
        const listDiv = document.getElementById('existingReportsList');
        
        if (data.status === 'success' && data.reports.length > 0) {
            let html = '<div style="max-height: 200px; overflow-y: auto;">';
            data.reports.forEach(report => {
                const sizeKB = Math.round(report.size / 1024);
                html += `
                    <div class="monthly-report-item" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; margin-bottom: 6px; background: var(--bg-color); border-radius: 6px; cursor: pointer;" onclick="downloadMonthlyReport('${report.filename}')">
                        <div>
                            <span style="font-weight: 500;">${report.display_name}</span>
                            <span style="color: var(--text-light); font-size: 12px; margin-left: 8px;">${sizeKB}KB</span>
                        </div>
                        <span style="color: var(--primary-color); font-size: 13px;">📥 下载</span>
                    </div>
                `;
            });
            html += '</div>';
            listDiv.innerHTML = html;
        } else {
            listDiv.innerHTML = '<p style="text-align: center; color: var(--text-light); padding: 20px;">暂无已生成的月报</p>';
        }
    } catch (e) {
        console.error('获取月报列表失败:', e);
        document.getElementById('existingReportsList').innerHTML = '<p style="text-align: center; color: var(--danger-color); padding: 20px;">加载失败</p>';
    }
}

/**
 * 下载月报文件
 */
function downloadMonthlyReport(filename) {
    const url = '/api/report/download/' + filename;
    window.open(url, '_blank');
}

/**
 * 根据选中的年份更新月份选项
 */
function updateMonthOptions() {
    const yearSelect = document.getElementById('reportYear');
    const monthSelect = document.getElementById('reportMonth');
    
    const selectedYear = yearSelect.value;
    if (!selectedYear) {
        monthSelect.innerHTML = '<option value="">请先选择年份</option>';
        return;
    }
    
    // 获取该年份的可用月份
    const monthsData = JSON.parse(yearSelect.dataset.monthsData || '{}');
    const months = monthsData[selectedYear] || [];
    
    if (months.length > 0) {
        monthSelect.innerHTML = months.map(m => `<option value="${parseInt(m)}">${parseInt(m)}月</option>`).join('');
    } else {
        monthSelect.innerHTML = '<option value="">该年暂无数据</option>';
    }
}

/**
 * 生成月报
 */
async function generateMonthlyReport() {
    const year = parseInt(document.getElementById('reportYear').value);
    const month = parseInt(document.getElementById('reportMonth').value);
    
    closeModal('monthlyReportModal');
    showToast(`正在生成${year}年${month}月月报...`);
    
    try {
        const res = await fetch('/api/report/monthly', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year, month })
        });
        
        const data = await res.json();
        
        if (data.status === 'success') {
            showToast(`✅ 月报已生成！文件已保存至 Report/${data.filename}`);
        } else {
            alert('❌ 生成月报失败：' + (data.message || '未知错误'));
        }
    } catch (e) {
        console.error('生成月报失败:', e);
        alert('❌ 生成月报失败，请检查服务是否正常运行');
    }
}

// ============ 工具函数 ============
function closeModal(id) {
    document.getElementById(id).classList.remove('show');
}

// ============ 彩蛋函数 ============
function showEasterEgg() {
    const modal = document.getElementById('easterEggModal');
    const confettis = modal.querySelectorAll('.confetti-circle, .confetti-star');
    
    // 重置所有撒花粒子的动画
    confettis.forEach(c => {
        c.style.animation = 'none';
        c.offsetHeight; // 强制重绘
        c.style.animation = null;
    });
    
    modal.classList.add('show');
}

function closeEasterEgg() {
    document.getElementById('easterEggModal').classList.remove('show');
}

// 点击彩蛋弹窗外部关闭
document.getElementById('easterEggModal').addEventListener('click', function(e) {
    if (e.target === this) {
        closeEasterEgg();
    }
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.classList.remove('show');
        }
    });
});