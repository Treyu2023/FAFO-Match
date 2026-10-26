import unittest

from presence_lease import decide


class LeaseTests(unittest.TestCase):
    def test_chrome_keeps_only_the_tagger(self):
        s1, s2 = decide(
            chrome=True,
            toolbox_active=False,
            s1_sleeping=False,
            s2_sleeping=False,
            s1_demand_age=None,
            s2_demand_age=None,
        )
        self.assertFalse(s1)
        self.assertTrue(s2)

    def test_both_closed_stops_both(self):
        s1, s2 = decide(
            chrome=False,
            toolbox_active=False,
            s1_sleeping=False,
            s2_sleeping=False,
            s1_demand_age=999,
            s2_demand_age=999,
        )
        self.assertFalse(s1)
        self.assertFalse(s2)

    def test_toolbox_open_keeps_tagger_too(self):
        s1, s2 = decide(
            chrome=False,
            toolbox_active=True,
            s1_sleeping=False,
            s2_sleeping=False,
            s1_demand_age=None,
            s2_demand_age=None,
        )
        self.assertTrue(s1)
        self.assertTrue(s2)

    def test_unknown_chrome_does_not_kill_tagger(self):
        _s1, s2 = decide(
            chrome=None,
            toolbox_active=False,
            s1_sleeping=False,
            s2_sleeping=False,
            s1_demand_age=None,
            s2_demand_age=None,
        )
        self.assertTrue(s2)

    def test_sleep_sticks(self):
        s1, s2 = decide(
            chrome=True,
            toolbox_active=True,
            s1_sleeping=True,
            s2_sleeping=True,
            s1_demand_age=1,
            s2_demand_age=1,
        )
        self.assertFalse(s1)
        self.assertFalse(s2)


if __name__ == "__main__":
    unittest.main()
