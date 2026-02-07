import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import SettingsModal from './SettingsModal';
import './Nav.css';

const Nav = ({ showSettings = true }) => {
  return (
    <>
      <nav>
        <ul>
          <li>
            <Link to="/import">Tweet Knowledge Explorer</Link>
          </li>
          {showSettings && (
            <li className="settings">
              <SettingsModal tooltip={false} color="secondary" variant="clear" />
            </li>
          )}
        </ul>
      </nav>
      {/* <SubNav /> */}
    </>
  );
};

Nav.propTypes = {
  showSettings: PropTypes.bool,
};

export default Nav;
