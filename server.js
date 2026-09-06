require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

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

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
