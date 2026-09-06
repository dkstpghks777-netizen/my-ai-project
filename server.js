require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { XMLParser } = require('fast-xml-parser');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

const WORKSPACE_FOLDER_NAME = process.env.DRIVE_WORKSPACE_FOLDER_NAME || 'my-ai-project-workspace';
const upload = multer({ storage: multer.memoryStorage() });

function getDriveClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_DRIVE_CLIENT_ID,
    process.env.GOOGLE_DRIVE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

let workspaceFolderIdCache = null;

async function getOrCreateWorkspaceFolder(drive) {
  if (workspaceFolderIdCache) return workspaceFolderIdCache;

  const existing = await drive.files.list({
    q: `name='${WORKSPACE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  if (existing.data.files.length > 0) {
    workspaceFolderIdCache = existing.data.files[0].id;
    return workspaceFolderIdCache;
  }

  const created = await drive.files.create({
    requestBody: {
      name: WORKSPACE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });

  workspaceFolderIdCache = created.data.id;
  return workspaceFolderIdCache;
}

function requireDriveConfig(res) {
  if (
    !process.env.GOOGLE_DRIVE_CLIENT_ID ||
    !process.env.GOOGLE_DRIVE_CLIENT_SECRET ||
    !process.env.GOOGLE_DRIVE_REFRESH_TOKEN
  ) {
    res.status(500).json({ error: 'Google Drive credentials are not configured' });
    return false;
  }
  return true;
}

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

function requireYoutubeKey(res) {
  if (!YOUTUBE_API_KEY) {
    res.status(500).json({ error: 'YOUTUBE_API_KEY is not configured' });
    return false;
  }
  return true;
}

// 키워드로 영상 검색 후 조회수/좋아요/댓글수까지 합쳐서 반환
app.get('/youtube/search', async (req, res) => {
  if (!requireYoutubeKey(res)) return;

  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }
  const maxResults = Math.min(parseInt(req.query.maxResults, 10) || 10, 50);

  try {
    const searchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&type=video&order=viewCount&maxResults=${maxResults}&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (searchData.error) {
      return res.status(searchData.error.code || 500).json({ error: searchData.error.message });
    }

    const videoIds = searchData.items.map((item) => item.id.videoId).join(',');
    if (!videoIds) {
      return res.json({ query, results: [] });
    }

    const statsUrl = `${YOUTUBE_API_BASE}/videos?part=snippet,statistics,contentDetails&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
    const statsRes = await fetch(statsUrl);
    const statsData = await statsRes.json();

    const results = statsData.items.map((item) => ({
      videoId: item.id,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      tags: item.snippet.tags || [],
      duration: item.contentDetails.duration,
      viewCount: Number(item.statistics.viewCount || 0),
      likeCount: Number(item.statistics.likeCount || 0),
      commentCount: Number(item.statistics.commentCount || 0),
      url: `https://www.youtube.com/watch?v=${item.id}`,
    }));

    res.json({ query, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 특정 지역의 인기 급상승 동영상 조회 (요즘 트렌드 파악용)
app.get('/youtube/trending', async (req, res) => {
  if (!requireYoutubeKey(res)) return;

  const region = req.query.region || 'KR';
  const maxResults = Math.min(parseInt(req.query.maxResults, 10) || 20, 50);
  const categoryId = req.query.categoryId;

  try {
    let url = `${YOUTUBE_API_BASE}/videos?part=snippet,statistics,contentDetails&chart=mostPopular&regionCode=${region}&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`;
    if (categoryId) url += `&videoCategoryId=${categoryId}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      return res.status(data.error.code || 500).json({ error: data.error.message });
    }

    const results = data.items.map((item) => ({
      videoId: item.id,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      categoryId: item.snippet.categoryId,
      tags: item.snippet.tags || [],
      duration: item.contentDetails.duration,
      viewCount: Number(item.statistics.viewCount || 0),
      likeCount: Number(item.statistics.likeCount || 0),
      commentCount: Number(item.statistics.commentCount || 0),
      url: `https://www.youtube.com/watch?v=${item.id}`,
    }));

    res.json({ region, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 특정 영상 하나의 상세 정보 (댓글 몇 개 미리보기 포함)
app.get('/youtube/video/:id', async (req, res) => {
  if (!requireYoutubeKey(res)) return;

  const videoId = req.params.id;

  try {
    const videoUrl = `${YOUTUBE_API_BASE}/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`;
    const videoRes = await fetch(videoUrl);
    const videoData = await videoRes.json();

    if (videoData.error) {
      return res.status(videoData.error.code || 500).json({ error: videoData.error.message });
    }
    if (!videoData.items.length) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const item = videoData.items[0];

    const commentsUrl = `${YOUTUBE_API_BASE}/commentThreads?part=snippet&videoId=${videoId}&maxResults=10&order=relevance&key=${YOUTUBE_API_KEY}`;
    const commentsRes = await fetch(commentsUrl);
    const commentsData = await commentsRes.json();
    const topComments = (commentsData.items || []).map((c) => ({
      author: c.snippet.topLevelComment.snippet.authorDisplayName,
      text: c.snippet.topLevelComment.snippet.textDisplay,
      likeCount: c.snippet.topLevelComment.snippet.likeCount,
    }));

    res.json({
      videoId: item.id,
      title: item.snippet.title,
      description: item.snippet.description,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      tags: item.snippet.tags || [],
      duration: item.contentDetails.duration,
      viewCount: Number(item.statistics.viewCount || 0),
      likeCount: Number(item.statistics.likeCount || 0),
      commentCount: Number(item.statistics.commentCount || 0),
      topComments,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function requireNaverKeys(res) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    res.status(500).json({ error: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET is not configured' });
    return false;
  }
  return true;
}

// 네이버 통합 검색어 트렌드 (일자별 상대 검색량 추이)
app.get('/naver/trend', async (req, res) => {
  if (!requireNaverKeys(res)) return;

  const keyword = req.query.keyword;
  if (!keyword) {
    return res.status(400).json({ error: 'Query parameter "keyword" is required' });
  }

  const endDate = req.query.endDate || new Date().toISOString().slice(0, 10);
  const startDate =
    req.query.startDate ||
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const timeUnit = req.query.timeUnit || 'date';

  try {
    const response = await fetch('https://openapi.naver.com/v1/datalab/search', {
      method: 'POST',
      headers: {
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        startDate,
        endDate,
        timeUnit,
        keywordGroups: [{ groupName: keyword, keywords: [keyword] }],
      }),
    });
    const data = await response.json();

    if (data.errorMessage) {
      return res.status(response.status).json({ error: data.errorMessage });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 네이버 블로그/카페/뉴스 등 검색 결과 조회
app.get('/naver/search', async (req, res) => {
  if (!requireNaverKeys(res)) return;

  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }
  const type = req.query.type || 'blog'; // blog, cafearticle, news, shop 등
  const display = Math.min(parseInt(req.query.display, 10) || 10, 100);
  const sort = req.query.sort || 'sim'; // sim(정확도) or date

  try {
    const url = `https://openapi.naver.com/v1/search/${type}.json?query=${encodeURIComponent(query)}&display=${display}&sort=${sort}`;
    const response = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
      },
    });
    const data = await response.json();

    if (data.errorMessage) {
      return res.status(response.status).json({ error: data.errorMessage });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 구글 트렌드 실시간 인기 검색어 (한국 기본) - 공식 공개 RSS 피드 사용
app.get('/trends/realtime', async (req, res) => {
  const geo = req.query.geo || 'KR';

  try {
    const response = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`);
    const xml = await response.text();

    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);

    let items = parsed?.rss?.channel?.item || [];
    if (!Array.isArray(items)) items = [items];

    const results = items.map((item) => {
      let newsItems = item['ht:news_item'] || [];
      if (!Array.isArray(newsItems)) newsItems = [newsItems];

      return {
        keyword: item.title,
        approxTraffic: item['ht:approx_traffic'],
        publishedAt: item.pubDate,
        relatedNews: newsItems
          .filter(Boolean)
          .map((n) => ({
            title: n['ht:news_item_title'],
            source: n['ht:news_item_source'],
            url: n['ht:news_item_url'],
          })),
      };
    });

    res.json({ geo, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 워크스페이스 폴더 안의 파일 목록 조회
app.get('/drive/files', async (req, res) => {
  if (!requireDriveConfig(res)) return;

  try {
    const drive = getDriveClient();
    const folderId = await getOrCreateWorkspaceFolder(drive);

    const result = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)',
      orderBy: 'modifiedTime desc',
    });

    res.json({ folderId, files: result.data.files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 워크스페이스 폴더에 파일 업로드 (multipart/form-data, 필드명 "file")
app.post('/drive/upload', upload.single('file'), async (req, res) => {
  if (!requireDriveConfig(res)) return;
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded (field name should be "file")' });
  }

  try {
    const drive = getDriveClient();
    const folderId = await getOrCreateWorkspaceFolder(drive);
    const { Readable } = require('stream');

    const result = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        parents: [folderId],
      },
      media: {
        mimeType: req.file.mimetype,
        body: Readable.from(req.file.buffer),
      },
      fields: 'id, name, webViewLink',
    });

    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 워크스페이스 폴더의 특정 파일 다운로드
app.get('/drive/files/:id/download', async (req, res) => {
  if (!requireDriveConfig(res)) return;

  try {
    const drive = getDriveClient();
    const fileMeta = await drive.files.get({ fileId: req.params.id, fields: 'name, mimeType' });
    const fileRes = await drive.files.get(
      { fileId: req.params.id, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Disposition', `attachment; filename="${fileMeta.data.name}"`);
    res.setHeader('Content-Type', fileMeta.data.mimeType);
    fileRes.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 워크스페이스 폴더의 특정 파일 삭제
app.delete('/drive/files/:id', async (req, res) => {
  if (!requireDriveConfig(res)) return;

  try {
    const drive = getDriveClient();
    await drive.files.delete({ fileId: req.params.id });
    res.json({ deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
