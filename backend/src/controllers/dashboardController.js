import { SearchHistory } from '../models/SearchHistory.js';

export const myDashboard = async (req, res) => {
  const recentSearches = await SearchHistory.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  const sourceBreakdown = await SearchHistory.aggregate([
    { $match: { user: req.user._id } },
    { $group: { _id: '$source', count: { $sum: 1 } } }
  ]);

  res.status(200).json({
    success: true,
    data: {
      recentSearches,
      sourceBreakdown
    }
  });
};

export const deleteRecentSearch = async (req, res) => {
  const { id } = req.params;

  const deleted = await SearchHistory.findOneAndDelete({
    _id: id,
    user: req.user._id
  });

  if (!deleted) {
    return res.status(404).json({
      success: false,
      message: 'Recent search not found'
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Recent search deleted'
  });
};