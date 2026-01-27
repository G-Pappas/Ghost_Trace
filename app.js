/**
 * GhostTrace - Instagram Follower Tracker
 * Core application logic
 */

// ========================================
// Utility Functions
// ========================================

/**
 * Escapes HTML special characters to prevent XSS attacks
 * @param {string} str - The string to escape
 * @returns {string} - The escaped string
 */
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ========================================
// Database Manager (IndexedDB)
// ========================================
class DatabaseManager {
    constructor() {
        this.dbName = 'GhostTraceDB';
        this.dbVersion = 1;
        this.db = null;
        this.isAvailable = true;
    }

    async init() {
        // Check if IndexedDB is available
        if (!window.indexedDB) {
            console.warn('IndexedDB is not available. Data will not persist.');
            this.isAvailable = false;
            return null;
        }

        return new Promise((resolve, reject) => {
            try {
                const request = indexedDB.open(this.dbName, this.dbVersion);

                request.onerror = () => {
                    console.warn('IndexedDB error:', request.error);
                    this.isAvailable = false;
                    resolve(null); // Resolve with null instead of rejecting
                };

                request.onsuccess = () => {
                    this.db = request.result;
                    resolve(this.db);
                };

                request.onupgradeneeded = (event) => {
                    const db = event.target.result;

                    // Snapshots store
                    if (!db.objectStoreNames.contains('snapshots')) {
                        const store = db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
                        store.createIndex('date', 'date', { unique: false });
                    }

                    // Settings store
                    if (!db.objectStoreNames.contains('settings')) {
                        db.createObjectStore('settings', { keyPath: 'key' });
                    }
                };
            } catch (error) {
                console.warn('IndexedDB initialization failed:', error);
                this.isAvailable = false;
                resolve(null);
            }
        });
    }

    async saveSnapshot(followers, following) {
        if (!this.isAvailable || !this.db) {
            console.warn('Database not available, snapshot not saved');
            return null;
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['snapshots'], 'readwrite');
            const store = transaction.objectStore('snapshots');

            const snapshot = {
                date: new Date().toISOString(),
                followers: followers,
                following: following
            };

            const request = store.add(snapshot);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getSnapshots() {
        if (!this.isAvailable || !this.db) {
            return [];
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['snapshots'], 'readonly');
            const store = transaction.objectStore('snapshots');
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getLatestSnapshot() {
        const snapshots = await this.getSnapshots();
        if (snapshots.length === 0) return null;
        return snapshots.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    }

    async getPreviousSnapshot() {
        const snapshots = await this.getSnapshots();
        if (snapshots.length < 2) return null;
        const sorted = snapshots.sort((a, b) => new Date(b.date) - new Date(a.date));
        return sorted[1];
    }

    async saveSetting(key, value) {
        if (!this.isAvailable || !this.db) {
            return;
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['settings'], 'readwrite');
            const store = transaction.objectStore('settings');
            const request = store.put({ key, value });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getSetting(key) {
        if (!this.isAvailable || !this.db) {
            return null;
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['settings'], 'readonly');
            const store = transaction.objectStore('settings');
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result?.value);
            request.onerror = () => reject(request.error);
        });
    }

    // Whitelist methods
    async getWhitelist() {
        const whitelist = await this.getSetting('whitelist');
        return whitelist || [];
    }

    async addToWhitelist(username) {
        const whitelist = await this.getWhitelist();
        const lowerUsername = username.toLowerCase();
        if (!whitelist.includes(lowerUsername)) {
            whitelist.push(lowerUsername);
            await this.saveSetting('whitelist', whitelist);
        }
    }

    async removeFromWhitelist(username) {
        const whitelist = await this.getWhitelist();
        const lowerUsername = username.toLowerCase();
        const newWhitelist = whitelist.filter(u => u !== lowerUsername);
        await this.saveSetting('whitelist', newWhitelist);
    }

    async isWhitelisted(username) {
        const whitelist = await this.getWhitelist();
        return whitelist.includes(username.toLowerCase());
    }
}

// ========================================
// Instagram Data Parser
// ========================================
class InstagramDataParser {
    static parseFollowers(jsonData) {
        try {
            // Validate input
            if (!jsonData) {
                throw new Error('File appears to be empty');
            }

            // Instagram exports followers as array of objects
            const users = [];

            if (!Array.isArray(jsonData)) {
                throw new Error('Expected Instagram export format. File should contain an array of follower data.');
            }

            if (jsonData.length === 0) {
                return users; // Empty but valid
            }

            // Check if first item has expected structure
            const firstItem = jsonData[0];
            if (!firstItem.string_list_data && !firstItem.value) {
                throw new Error('Unrecognized file format. Make sure you uploaded the followers_1.json file from Instagram export.');
            }

            jsonData.forEach(item => {
                if (item.string_list_data && Array.isArray(item.string_list_data)) {
                    item.string_list_data.forEach(data => {
                        if (data.value) {
                            users.push({
                                username: data.value,
                                timestamp: data.timestamp || null,
                                href: data.href || null
                            });
                        }
                    });
                }
            });

            return users;
        } catch (error) {
            console.error('Error parsing followers:', error);
            throw error;
        }
    }

    static parseFollowing(jsonData) {
        try {
            // Validate input
            if (!jsonData) {
                throw new Error('File appears to be empty');
            }

            const users = [];

            // Following can be in relationships_following format
            if (Array.isArray(jsonData)) {
                if (jsonData.length === 0) {
                    return users; // Empty but valid
                }

                // Check if first item has expected structure
                const firstItem = jsonData[0];
                if (!firstItem.title && !firstItem.string_list_data && !firstItem.value) {
                    throw new Error('Unrecognized file format. Make sure you uploaded the following.json file from Instagram export.');
                }

                jsonData.forEach(item => {
                    // Check if username is in title (new Instagram format)
                    if (item.title) {
                        const data = item.string_list_data?.[0] || {};
                        users.push({
                            username: item.title,
                            timestamp: data.timestamp || null,
                            href: data.href || null
                        });
                    } else if (item.string_list_data && Array.isArray(item.string_list_data)) {
                        // Fallback to old format with value in string_list_data
                        item.string_list_data.forEach(data => {
                            if (data.value) {
                                users.push({
                                    username: data.value,
                                    timestamp: data.timestamp || null,
                                    href: data.href || null
                                });
                            }
                        });
                    }
                });
            } else if (jsonData.relationships_following) {
                // Alternative format with relationships_following wrapper
                jsonData.relationships_following.forEach(item => {
                    // Check if username is in title (new Instagram format)
                    if (item.title) {
                        const data = item.string_list_data?.[0] || {};
                        users.push({
                            username: item.title,
                            timestamp: data.timestamp || null,
                            href: data.href || null
                        });
                    } else if (item.string_list_data) {
                        // Fallback to old format
                        item.string_list_data.forEach(data => {
                            if (data.value) {
                                users.push({
                                    username: data.value,
                                    timestamp: data.timestamp || null,
                                    href: data.href || null
                                });
                            }
                        });
                    }
                });
            } else {
                throw new Error('Expected Instagram export format. File should contain following data or relationships_following array.');
            }

            return users;
        } catch (error) {
            console.error('Error parsing following:', error);
            throw error;
        }
    }
}

// ========================================
// Comparison Engine
// ========================================
class ComparisonEngine {
    static findUnfollowers(previousFollowers, currentFollowers) {
        const currentSet = new Set(currentFollowers.map(u => u.username.toLowerCase()));
        return previousFollowers.filter(u => !currentSet.has(u.username.toLowerCase()));
    }

    static findNewFollowers(previousFollowers, currentFollowers) {
        const previousSet = new Set(previousFollowers.map(u => u.username.toLowerCase()));
        return currentFollowers.filter(u => !previousSet.has(u.username.toLowerCase()));
    }

    static findNotFollowingBack(followers, following) {
        const followersSet = new Set(followers.map(u => u.username.toLowerCase()));
        return following.filter(u => !followersSet.has(u.username.toLowerCase()));
    }
}

// ========================================
// UI Controller
// ========================================
class UIController {
    constructor(db) {
        this.db = db;
        this.uploadedFiles = {};
        this.currentData = null;
        this.currentTab = 'unfollowers';
        this.searchQuery = '';
        this.whitelist = [];
        this.showWhitelisted = false;

        this.initElements();
        this.initEventListeners();
        this.initTheme();
        this.loadHistory();
        this.loadWhitelist();
        this.autoLoadLatest();
    }

    initElements() {
        this.dropzone = document.getElementById('dropzone');
        this.fileInput = document.getElementById('fileInput');
        this.uploadedFilesContainer = document.getElementById('uploadedFiles');
        this.analyzeBtn = document.getElementById('analyzeBtn');
        this.resultsSection = document.getElementById('resultsSection');
        this.historyList = document.getElementById('historyList');
        this.userList = document.getElementById('userList');
        this.emptyState = document.getElementById('emptyState');
        this.searchInput = document.getElementById('searchInput');
        this.themeToggle = document.getElementById('themeToggle');
        this.toastContainer = document.getElementById('toastContainer');

        // Stats
        this.followersCount = document.getElementById('followersCount');
        this.followingCount = document.getElementById('followingCount');
        this.unfollowersCount = document.getElementById('unfollowersCount');
        this.newFollowersCount = document.getElementById('newFollowersCount');
        this.notFollowingBackCount = document.getElementById('notFollowingBackCount');

        // Action buttons
        this.exportBtn = document.getElementById('exportBtn');
        this.shareBtn = document.getElementById('shareBtn');
    }

    initEventListeners() {
        // Dropzone events
        this.dropzone.addEventListener('click', () => this.fileInput.click());
        this.dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.dropzone.classList.add('drag-over');
        });
        this.dropzone.addEventListener('dragleave', () => {
            this.dropzone.classList.remove('drag-over');
        });
        this.dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.dropzone.classList.remove('drag-over');
            this.handleFiles(e.dataTransfer.files);
        });

        // File input
        this.fileInput.addEventListener('change', (e) => {
            this.handleFiles(e.target.files);
        });

        // Analyze button
        this.analyzeBtn.addEventListener('click', () => this.analyzeData());

        // Tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        // Search
        this.searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.toLowerCase();
            this.renderUserList();
        });

        // Theme toggle
        this.themeToggle.addEventListener('click', () => this.toggleTheme());

        // Export button
        this.exportBtn.addEventListener('click', () => this.exportToCSV());

        // Share button
        this.shareBtn.addEventListener('click', () => this.shareOnX());

        // Demo button
        const demoBtn = document.getElementById('demoBtn');
        if (demoBtn) {
            demoBtn.addEventListener('click', () => this.loadDemoData());
        }
    }

    async loadDemoData() {
        try {
            // Load test data files
            const followersResponse = await fetch('test_data/followers_1.json');
            const followingResponse = await fetch('test_data/following.json');

            if (!followersResponse.ok || !followingResponse.ok) {
                this.showToast('Demo data files not found. Please ensure test_data folder exists.', 'error');
                return;
            }

            const followersData = await followersResponse.json();
            const followingData = await followingResponse.json();

            // Set as uploaded files
            this.uploadedFiles.followers = { name: 'demo_followers.json', data: followersData };
            this.uploadedFiles.following = { name: 'demo_following.json', data: followingData };

            // Update UI
            this.renderUploadedFiles();
            this.updateAnalyzeButton();

            // Auto-analyze
            this.showToast('Demo data loaded! Analyzing...', 'success');
            setTimeout(() => this.analyzeData(), 500);

        } catch (error) {
            console.error('Error loading demo data:', error);
            this.showToast('Failed to load demo data. ' + error.message, 'error');
        }
    }

    async initTheme() {
        // Check localStorage first (for cross-page consistency)
        const localTheme = localStorage.getItem('ghosttrace-theme');
        const dbTheme = await this.db.getSetting('theme');
        const savedTheme = localTheme || dbTheme;

        if (savedTheme) {
            document.documentElement.setAttribute('data-theme', savedTheme);
            this.updateThemeIcon(savedTheme);
        } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.documentElement.setAttribute('data-theme', 'dark');
            this.updateThemeIcon('dark');
        }
    }

    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', newTheme);
        this.updateThemeIcon(newTheme);
        // Save to both localStorage (for cross-page sync) and IndexedDB (for backup)
        localStorage.setItem('ghosttrace-theme', newTheme);
        this.db.saveSetting('theme', newTheme);
    }

    updateThemeIcon(theme) {
        const icon = this.themeToggle.querySelector('.theme-icon');
        icon.textContent = theme === 'dark' ? '☀️' : '🌙';
    }

    async handleFiles(files) {
        for (const file of files) {
            if (!file.name.endsWith('.json')) {
                this.showToast('Please upload JSON files only', 'error');
                continue;
            }

            try {
                await this.processFile(file);
            } catch (error) {
                console.error('File handling error:', error);
            }
        }
    }

    async processFile(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);

            // Validate file structure and determine type
            if (this.isFollowersFile(data)) {
                this.uploadedFiles.followers = { name: file.name, data };
                this.showToast(`✅ Followers file loaded: ${file.name}`, 'success');
            } else if (this.isFollowingFile(data)) {
                this.uploadedFiles.following = { name: file.name, data };
                this.showToast(`✅ Following file loaded: ${file.name}`, 'success');
            } else {
                // Provide helpful error message
                this.showToast(
                    `❌ This doesn't look like an Instagram export file. Please upload "followers_1.json" or "following.json" from Instagram's official data export (Settings → Security → Download Your Information).`,
                    'error'
                );
                return;
            }

            this.renderUploadedFiles();
            this.updateAnalyzeButton();

        } catch (error) {
            console.error('File processing error:', error);

            // Specific error messages based on error type
            if (error instanceof SyntaxError) {
                this.showToast(
                    `❌ Invalid JSON file. Make sure you're uploading the original files from Instagram without editing them. File: ${file.name}`,
                    'error'
                );
            } else {
                this.showToast(
                    `❌ Error reading file "${file.name}". Please try downloading your Instagram data again. Error: ${error.message}`,
                    'error'
                );
            }
        }
    }

    // Helper methods to determine file type based on content structure
    isFollowersFile(data) {
        return Array.isArray(data) && data.every(item => typeof item === 'object' && item !== null && 'string_list_data' in item);
    }

    isFollowingFile(data) {
        return (typeof data === 'object' && data !== null && 'relationships_following' in data && Array.isArray(data.relationships_following)) ||
            (Array.isArray(data) && data.every(item => typeof item === 'object' && item !== null && 'string_list_data' in item));
    }

    readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
        });
    }

    renderUploadedFiles() {
        this.uploadedFilesContainer.innerHTML = '';

        Object.entries(this.uploadedFiles).forEach(([type, file]) => {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.innerHTML = `
                <span class="file-icon">📄</span>
                <span class="file-name">${escapeHtml(file.name)}</span>
                <span class="file-status">✓</span>
                <button class="file-remove" data-type="${escapeHtml(type)}" aria-label="Remove ${escapeHtml(file.name)}">✕</button>
            `;

            item.querySelector('.file-remove').addEventListener('click', () => {
                delete this.uploadedFiles[type];
                this.renderUploadedFiles();
                this.updateAnalyzeButton();
            });

            this.uploadedFilesContainer.appendChild(item);
        });
    }

    updateAnalyzeButton() {
        const hasFollowers = 'followers' in this.uploadedFiles || 'unknown' in this.uploadedFiles;
        const hasFollowing = 'following' in this.uploadedFiles || 'unknown' in this.uploadedFiles;
        this.analyzeBtn.disabled = !(hasFollowers || hasFollowing);
    }

    async analyzeData() {
        if (!this.uploadedFiles.followers || !this.uploadedFiles.following) {
            this.showToast('Please upload both followers and following files', 'error');
            return;
        }

        try {
            // Show loading state
            this.analyzeBtn.disabled = true;
            this.analyzeBtn.innerHTML = '<span class="spinner"></span> Analyzing...';

            // Parse data
            const followers = InstagramDataParser.parseFollowers(this.uploadedFiles.followers.data);
            const following = InstagramDataParser.parseFollowing(this.uploadedFiles.following.data);

            // Load previous snapshot
            const previousSnapshot = await this.db.getLatestSnapshot();

            // Save current snapshot
            await this.db.saveSnapshot(followers, following);

            // Calculate comparisons
            let unfollowers = [];
            let newFollowers = [];
            if (previousSnapshot) {
                unfollowers = ComparisonEngine.findUnfollowers(previousSnapshot.followers, followers);
                newFollowers = ComparisonEngine.findNewFollowers(previousSnapshot.followers, followers);
            }

            const notFollowingBack = ComparisonEngine.findNotFollowingBack(followers, following);

            // Store current data
            this.currentData = {
                followers,
                following,
                unfollowers,
                newFollowers,
                notFollowingBack
            };

            // Update UI
            this.displayResults();
            this.loadHistory();

            this.showToast('Analysis complete!', 'success');
        } catch (error) {
            console.error('Analysis error:', error);
            this.showToast('Error analyzing data: ' + error.message, 'error');
        } finally {
            this.analyzeBtn.innerHTML = '<span class="btn-icon">🔍</span> Analyze Data';
            this.analyzeBtn.disabled = false;
        }
    }


    displayResults() {
        // Update stats directly without animation
        this.followersCount.textContent = this.currentData.followers.length;
        this.followingCount.textContent = this.currentData.following.length;
        this.unfollowersCount.textContent = this.currentData.unfollowers.length;
        this.newFollowersCount.textContent = this.currentData.newFollowers?.length || 0;
        this.notFollowingBackCount.textContent = this.currentData.notFollowingBack.length;

        // Show results section
        this.resultsSection.hidden = false;

        // Render user list
        this.renderUserList();

        // Scroll to results
        this.resultsSection.scrollIntoView({ behavior: 'smooth' });
    }

    switchTab(tab) {
        this.currentTab = tab;

        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        // Render user list
        this.renderUserList();
    }

    async loadWhitelist() {
        this.whitelist = await this.db.getWhitelist();
    }

    async toggleWhitelist(username) {
        try {
            const lowerUsername = username.toLowerCase();
            if (this.whitelist.includes(lowerUsername)) {
                await this.db.removeFromWhitelist(username);
                this.whitelist = this.whitelist.filter(u => u !== lowerUsername);
                this.showToast(`Removed @${username} from whitelist`, 'success');
            } else {
                await this.db.addToWhitelist(username);
                this.whitelist.push(lowerUsername);
                this.showToast(`Added @${username} to whitelist`, 'success');
            }
            this.renderUserList();
            this.updateNotFollowingBackCount();
        } catch (error) {
            console.error('Whitelist operation failed:', error);
            this.showToast('Failed to update whitelist', 'error');
        }
    }

    updateNotFollowingBackCount() {
        if (!this.currentData) return;
        const filtered = this.currentData.notFollowingBack.filter(
            u => !this.whitelist.includes(u.username.toLowerCase())
        );
        this.notFollowingBackCount.textContent = filtered.length;
    }

    renderUserList() {
        if (!this.currentData) return;

        let users = [];
        let isNotFollowingBackTab = false;
        let isWhitelistTab = false;

        switch (this.currentTab) {
            case 'unfollowers':
                users = this.currentData.unfollowers;
                break;
            case 'newFollowers':
                users = this.currentData.newFollowers || [];
                break;
            case 'notFollowingBack':
                users = this.currentData.notFollowingBack;
                isNotFollowingBackTab = true;
                // Filter out whitelisted users
                users = users.filter(u => !this.whitelist.includes(u.username.toLowerCase()));
                break;
            case 'whitelist':
                // Show only whitelisted users from notFollowingBack
                users = this.currentData.notFollowingBack.filter(
                    u => this.whitelist.includes(u.username.toLowerCase())
                );
                isWhitelistTab = true;
                break;
            case 'followers':
                users = this.currentData.followers;
                break;
            case 'following':
                users = this.currentData.following;
                break;
        }

        // Filter by search
        if (this.searchQuery) {
            users = users.filter(u => u.username.toLowerCase().includes(this.searchQuery));
        }

        // Clear list
        this.userList.innerHTML = '';

        if (users.length === 0) {
            this.emptyState.hidden = false;
            this.userList.hidden = true;
            return;
        }

        this.emptyState.hidden = true;
        this.userList.hidden = false;

        // Render users
        users.forEach((user) => {
            const item = document.createElement('div');
            item.className = 'user-item';
            // No animation delay

            const initial = user.username.charAt(0).toUpperCase();
            const profileUrl = user.href || `https://instagram.com/${user.username}`;
            const timeAgo = user.timestamp ? this.formatTimeAgo(user.timestamp * 1000) : '';
            const isWhitelisted = this.whitelist.includes(user.username.toLowerCase());

            // Show whitelist button for notFollowingBack and whitelist tabs
            const showWhitelistBtn = isNotFollowingBackTab || isWhitelistTab;
            const whitelistBtnText = isWhitelisted ? '✓ Whitelisted' : 'Whitelist';
            const whitelistBtnClass = isWhitelisted ? 'user-action whitelist-btn whitelisted' : 'user-action whitelist-btn';

            item.innerHTML = `
                <div class="user-avatar">${escapeHtml(initial)}</div>
                <div class="user-info">
                    <div class="user-name">@${escapeHtml(user.username)}</div>
                    ${timeAgo ? `<div class="user-meta">${escapeHtml(timeAgo)}</div>` : ''}
                </div>
                ${showWhitelistBtn ? `<button class="${whitelistBtnClass}" data-username="${escapeHtml(user.username)}" aria-label="${isWhitelisted ? 'Remove from whitelist' : 'Add to whitelist'}">${whitelistBtnText}</button>` : ''}
                <a href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener" class="user-action" aria-label="View ${escapeHtml(user.username)} on Instagram">View Profile</a>
            `;

            // Add click handler for whitelist button
            if (showWhitelistBtn) {
                const btn = item.querySelector('.whitelist-btn');
                btn.addEventListener('click', () => this.toggleWhitelist(user.username));
            }

            this.userList.appendChild(item);
        });
    }

    formatTimeAgo(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));

        if (days === 0) return 'Today';
        if (days === 1) return 'Yesterday';
        if (days < 30) return `${days} days ago`;
        if (days < 365) return `${Math.floor(days / 30)} months ago`;
        return `${Math.floor(days / 365)} years ago`;
    }

    async loadHistory() {
        const snapshots = await this.db.getSnapshots();

        if (snapshots.length === 0) {
            this.historyList.innerHTML = '<p class="history-empty">No previous uploads yet</p>';
            return;
        }

        this.historyList.innerHTML = '';

        const sorted = snapshots.sort((a, b) => new Date(b.date) - new Date(a.date));

        sorted.slice(0, 5).forEach(snapshot => {
            const date = new Date(snapshot.date);
            const item = document.createElement('div');
            item.className = 'history-item';
            item.innerHTML = `
                <div>
                    <div class="history-date">${escapeHtml(date.toLocaleDateString())}</div>
                    <div class="history-stats">${snapshot.followers.length} followers • ${snapshot.following.length} following</div>
                </div>
                <button class="history-load" data-id="${snapshot.id}" aria-label="Load snapshot from ${escapeHtml(date.toLocaleDateString())}">Load</button>
            `;

            // Add click handler for load button
            item.querySelector('.history-load').addEventListener('click', () => {
                this.loadSnapshot(snapshot);
            });

            this.historyList.appendChild(item);
        });
    }

    async autoLoadLatest() {
        const latestSnapshot = await this.db.getLatestSnapshot();
        if (latestSnapshot) {
            this.loadSnapshot(latestSnapshot, false);
        }
    }

    loadSnapshot(snapshot, showToast = true) {
        const followers = snapshot.followers || [];
        const following = snapshot.following || [];

        // Calculate comparisons
        const notFollowingBack = ComparisonEngine.findNotFollowingBack(followers, following);

        // For unfollowers and new followers, we need to compare with previous snapshot
        // For now, just show empty if no previous comparison data
        const unfollowers = [];
        const newFollowers = [];

        // Store current data
        this.currentData = {
            followers,
            following,
            unfollowers,
            newFollowers,
            notFollowingBack
        };

        // Update UI
        this.displayResults();
        this.updateNotFollowingBackCount();

        if (showToast) {
            const date = new Date(snapshot.date).toLocaleDateString();
            this.showToast(`Loaded snapshot from ${date}`, 'success');
        }
    }

    exportToCSV() {
        if (!this.currentData) {
            this.showToast('⚠️ Please analyze your data first before exporting', 'warning');
            return;
        }

        let users = [];
        let filename = 'ghosttrace_export.csv';

        // Get users based on current tab
        switch (this.currentTab) {
            case 'unfollowers':
                users = this.currentData.unfollowers;
                filename = 'unfollowers.csv';
                break;
            case 'newFollowers':
                users = this.currentData.newFollowers || [];
                filename = 'new_followers.csv';
                break;
            case 'notFollowingBack':
                users = this.currentData.notFollowingBack.filter(
                    u => !this.whitelist.includes(u.username.toLowerCase())
                );
                filename = 'not_following_back.csv';
                break;
            case 'whitelist':
                users = this.currentData.notFollowingBack.filter(
                    u => this.whitelist.includes(u.username.toLowerCase())
                );
                filename = 'whitelist.csv';
                break;
            case 'followers':
                users = this.currentData.followers;
                filename = 'followers.csv';
                break;
            case 'following':
                users = this.currentData.following;
                filename = 'following.csv';
                break;
        }

        if (users.length === 0) {
            this.showToast('No users to export in this tab', 'warning');
            return;
        }

        // Create CSV content
        const headers = ['Username', 'Profile URL', 'Date Added'];
        const rows = users.map(user => [
            user.username,
            user.href || `https://instagram.com/${user.username}`,
            user.timestamp ? new Date(user.timestamp * 1000).toLocaleDateString() : ''
        ]);

        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
        ].join('\n');

        // Add date to filename
        const date = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
        const filenameParts = filename.split('.');
        filename = `${filenameParts[0]}_${date}.${filenameParts[1]}`;

        // Download file
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);

        this.showToast(`Exported ${users.length} users to ${filename}`, 'success');
    }

    shareOnX() {
        if (!this.currentData) {
            this.showToast('Analyze your data first to share stats', 'error');
            return;
        }

        const followers = this.currentData.followers.length;
        const following = this.currentData.following.length;
        const unfollowers = this.currentData.unfollowers.length;
        const newFollowers = this.currentData.newFollowers?.length || 0;
        const notFollowingBack = this.currentData.notFollowingBack.length;

        const unfollowersCount = this.currentData.unfollowers.length;
        const notFollowingBackCount = this.currentData.notFollowingBack.length;

        const postText = `👻 My Instagram Stats:\n\n` +
            `📊 ${unfollowersCount} unfollowers detected\n` +
            `👤 ${notFollowingBackCount} not following me back\n\n` +
            `Track yours safely with #GhostTrace\n\n` +
            `#InstagramTracker`;

        const shareUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(postText)}`;
        window.open(shareUrl, '_blank', 'width=550,height=420');
    }

    showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'polite');
        toast.innerHTML = `
            <span aria-hidden="true">${type === 'success' ? '✓' : type === 'error' ? '✕' : '⚠'}</span>
            <span>${escapeHtml(message)}</span>
        `;

        this.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast-out');
            setTimeout(() => toast.remove(), 250);
        }, 3000);
    }
}

// ========================================
// Service Worker Registration
// ========================================
async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('./sw.js');
        } catch (error) {
            // Silent fail - SW is optional for core functionality
        }
    }
}

// ========================================
// Initialize App
// ========================================
async function initApp() {
    const db = new DatabaseManager();
    await db.init();

    new UIController(db);

    // Register service worker
    registerServiceWorker();
}

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', initApp);
