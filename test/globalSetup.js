// Sydney is UTC+10/+11 with DST, so local and UTC calendar dates differ for
// part of every day. Tests that rely on local dates must pass in this zone.
module.exports = async () => {
  process.env.TZ = 'Australia/Sydney';
};
