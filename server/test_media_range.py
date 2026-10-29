import unittest

from match_server import parse_byte_range


class RangeTests(unittest.TestCase):
    def test_open_end(self):
        self.assertEqual(parse_byte_range("bytes=0-", 1000), (0, 999))

    def test_middle(self):
        self.assertEqual(parse_byte_range("bytes=100-199", 1000), (100, 199))

    def test_suffix(self):
        self.assertEqual(parse_byte_range("bytes=-200", 1000), (800, 999))

    def test_whole_file_when_missing(self):
        self.assertIsNone(parse_byte_range(None, 1000))

    def test_past_the_end(self):
        with self.assertRaises(ValueError):
            parse_byte_range("bytes=5000-", 100)


if __name__ == "__main__":
    unittest.main()
